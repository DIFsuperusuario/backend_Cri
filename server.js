require('dotenv').config(); // 1. Configuración de entorno (Siempre primero)

const express = require("express"); // 2. Importar Express
const cors = require("cors");       // 3. Importar Cors
const { Pool } = require("pg");
const bcrypt = require("bcrypt");
const fs = require('fs');       
const path = require('path');   
const ExcelJS = require('exceljs');

// 4. CREAR LA APP (¡Vital hacer esto antes de usarla!)
const app = express(); 

// 5. ACTIVAR MIDDLEWARES (Aquí van Cors y JSON)
app.use(cors());          // <--- ¡Ahora sí! Deja pasar a todos (CORS)
app.use(express.json());  // <--- Permite leer JSON en las peticiones

// 6. PUERTO
const PORT = process.env.PORT || 3000;



// ---------------------------
// Configuración para servir archivos estáticos (Reportes)
// ---------------------------
const reportsDir = path.join(__dirname, 'reports');
if (!fs.existsSync(reportsDir)) {
    fs.mkdirSync(reportsDir); 
}

app.use('/reports', express.static(reportsDir));
app.use(cors());
app.use(express.json());

// ---------------------------
// Conexión a PostgreSQL (Modo Híbrido: Local y Nube)
// ---------------------------
const pool = new Pool({
  user: process.env.DB_USER,
  host: process.env.DB_HOST,
  database: process.env.DB_NAME,
  password: process.env.DB_PASSWORD,
  port: process.env.DB_PORT,
  // Esta línea es vital para conectarte desde tu casa a Railway
  ssl: {
    rejectUnauthorized: false
  }
});

/////////////////////////////adrian//////////////////////////////////////////////////////////////////////////////
// -----------------------------------------------------------------
// En server.js, busca la función queryReportData y agrega la línea marcada:

// -----------------------------------------------------------------
// FUNCIÓN CENTRAL: Consulta de Datos de Reporte (CORREGIDA)
// -----------------------------------------------------------------
async function queryReportData(client, type, year, month, area, limitRows = false) {
    let sql = `
        SELECT 
            p.id_paciente,
            p.nombre AS nombre_paciente,
            c.fecha,
            TO_CHAR(c.hora_inicio, 'HH24:MI') AS hora_inicio,
            TO_CHAR(c.hora_fin, 'HH24:MI') AS hora_fin,
            pe.nombre AS nombre_tratante, 
            c.servicio_area,
            c.estatus,
            c.asistencia,  -- <--- IMPORTANTE: Necesario para los colores en Flutter
            c.pago,
            c.motivo_pago,
            c.tipo_cita
        FROM citas c
        JOIN paciente p ON c.id_paciente = p.id_paciente
        LEFT JOIN personal pe ON c.id_personal = pe.id_personal -- <--- CAMBIO CLAVE: LEFT JOIN
        WHERE 1=1 
    `;
    // Nota sobre LEFT JOIN: 
    // Usamos LEFT JOIN para que traiga la cita AUNQUE no tenga terapeuta asignado todavía.
    // Si usas solo JOIN, las citas futuras sin doctor se borrarían del reporte.

    let params = [];
    let filterIndex = 1;

    // --- 1. FILTRO DE FECHAS ROBUSTO ---
    if (type === 'mensual' && month) {
        // Truco: Para asegurar que tomamos todo el mes, calculamos primer y último día
        const fechaInicio = `${year}-${month}-01`;
        const lastDay = new Date(year, month, 0).getDate(); // Mes exacto
        const fechaFin = `${year}-${month}-${lastDay}`;
        
        sql += ` AND c.fecha >= $${filterIndex++} AND c.fecha <= $${filterIndex++}`;
        params.push(fechaInicio, fechaFin);
        
    } else if (type === 'anual') {
        const fechaInicio = `${year}-01-01`;
        const fechaFin = `${year}-12-31`;
        
        sql += ` AND c.fecha >= $${filterIndex++} AND c.fecha <= $${filterIndex++}`;
        params.push(fechaInicio, fechaFin);
    } else {
        throw new Error("Filtros de fecha no válidos.");
    }
    
// --- 2. FILTRO DE ÁREA "INTELIGENTE" (JavaScript hace el trabajo) ---
    if (area && area !== 'TODOS') {
        // 1. Original (ej. "Terapeuta Físico")
        const areaOriginal = area.trim();
        
        // 2. Sin Acentos (ej. "Terapeuta Fisico")
        // Esta linea mágica de JS quita los acentos de forma segura
        const areaSinAcentos = areaOriginal.normalize("NFD").replace(/[\u0300-\u036f]/g, "");

        // SQL: "Búscame si el área coincide con la original O con la versión sin acentos"
        // Usamos LOWER para ignorar mayúsculas/minúsculas también.
        sql += ` AND (LOWER(c.servicio_area) = LOWER($${filterIndex++}) OR LOWER(c.servicio_area) = LOWER($${filterIndex++}))`;
        
        // Enviamos ambas opciones
        params.push(areaOriginal, areaSinAcentos);
    }

    // Ordenar por fecha y hora para que la matriz se llene en orden
    sql += ` ORDER BY c.fecha ASC, c.hora_inicio ASC`;
    
    if (limitRows) {
        sql += ` LIMIT 50000`; // Subí el límite un poco para que veas más datos en la preview
    }

    console.log(`🔍 Ejecutando SQL para Área: ${area || 'TODOS'}`); // Log para depurar
    const result = await client.query(sql, params);
    return result.rows;
}

// -----------------------------------------------------------------
// NUEVA FUNCIÓN: Consulta de Datos de CONTEO (CON FILTROS DE FECHA)
// -----------------------------------------------------------------
async function queryServiceCountData(client, type, year, month) {
    let params = [];
    let filterIndex = 1;

    // 1. LÓGICA DE FILTRADO DE FECHAS
    let fechaFilterSql = "";
    if (type === 'mensual' && month) {
        const fechaInicio = `${year}-${month}-01`;
        const lastDay = new Date(year, parseInt(month), 0).getDate(); 
        const fechaFin = `${year}-${month}-${lastDay}`;
        
        fechaFilterSql = ` AND c.fecha BETWEEN $${filterIndex++} AND $${filterIndex++}`;
        params.push(fechaInicio, fechaFin);
        
    } else if (type === 'anual') {
        const fechaInicio = `${year}-01-01`;
        const fechaFin = `${year}-12-31`;
        
        fechaFilterSql = ` AND c.fecha BETWEEN $${filterIndex++} AND $${filterIndex++}`;
        params.push(fechaInicio, fechaFin);
    } else {
         // Si no se especifica tipo/año, devolvemos un error 400 en la ruta GET
         throw new Error("Faltan parámetros de fecha para el conteo.");
    }

    // 2. CONSULTA SQL principal con el filtro de fecha inyectado
    const sql = `
        SELECT
            c.servicio_area AS "Servicio Brindado",
            COUNT(DISTINCT c.id_paciente) AS "Conteo No. Pacientes"
        FROM
            citas c
        WHERE
            c.servicio_area IN (
                'Terapeuta Fisico',
                'Terapeuta Autismo',
                'Terapeuta Lenguaje',
                'Psicologia', 
                'Médico'
            )
            -- 4 = Puntual, 5 = Tardía (solo contar pacientes que asistieron)
            AND c.asistencia IN (4, 5) 
            ${fechaFilterSql} -- AQUI SE INYECTA EL FILTRO
        GROUP BY
            c.servicio_area
        ORDER BY
            "Servicio Brindado";
    `;

    const result = await client.query(sql, params);
    return result.rows;
}

// -----------------------------------------------------------------
// FUNCIÓN MAESTRA: Generar Excel Tipo Matriz (Visualmente igual a la App)
// -----------------------------------------------------------------
async function generateExcelReport(data, fileName, filterInfo) {
    const workbook = new ExcelJS.Workbook();
    
    // 1. Agrupar datos por Terapeuta
    const porTerapeuta = {};
    data.forEach(cita => {
        const terapeuta = cita.nombre_tratante || 'SIN ASIGNAR';
        if (!porTerapeuta[terapeuta]) porTerapeuta[terapeuta] = [];
        porTerapeuta[terapeuta].push(cita);
    });

    // 2. Colores (ARGB) - Mismos que tu App
    const colors = {
        rosa: 'FFFF69B4',    // Justificada
        rojo: 'FFFF0000',    // Injustificada
        naranja: 'FFFFA500', // Falla Tratante
        verde: 'FF00B050',   // Asistió
        gris: 'FFBFBFBF',    // Pendiente
        azulHeader: 'FF4472C4', // Azul Cabecera
        azulTotal: 'FFD9E1F2',  // Azul clarito para Totales
        blanco: 'FFFFFFFF',
        negro: 'FF000000'
    };

    // Estilos Base
    const borderStyle = { top: { style: 'thin' }, left: { style: 'thin' }, bottom: { style: 'thin' }, right: { style: 'thin' } };
    const centerStyle = { vertical: 'middle', horizontal: 'center' };

    // --- PROCESAR CADA TERAPEUTA EN UNA HOJA O BLOQUE ---
    // (Aquí lo haremos todo en una sola hoja, separada por bloques, como en la app)
    const worksheet = workbook.addWorksheet('Matriz de Asistencia');

    // Título Principal
    worksheet.mergeCells('A1:AG1'); // Abarca hasta el día 31 aprox
    const titleCell = worksheet.getCell('A1');
    titleCell.value = `REPORTE DE ASISTENCIAS: ${filterInfo}`;
    titleCell.font = { bold: true, size: 14, color: { argb: colors.blanco } };
    titleCell.fill = { type: 'pattern', pattern: 'solid', fgColor: { argb: colors.azulHeader } };
    titleCell.alignment = centerStyle;

    // Leyenda
    worksheet.mergeCells('A2:AG2');
    const legendCell = worksheet.getCell('A2');
    legendCell.value = "LEYENDA: Rosa=Justificada | Rojo=Injustificada | Naranja=Falla Tratante | Verde=Asistió | Gris=Pendiente";
    legendCell.alignment = centerStyle;
    legendCell.font = { bold: true, color: { argb: 'FF555555' } };

    let currentRow = 4; // Empezamos en la fila 4

    // --- ITERAR POR CADA TERAPEUTA ---
    for (const [nombreTerapeuta, citas] of Object.entries(porTerapeuta)) {
        
        // A. Encabezado del Terapeuta
        worksheet.mergeCells(`A${currentRow}:AG${currentRow}`);
        const terapeutaCell = worksheet.getCell(`A${currentRow}`);
        terapeutaCell.value = `TERAPEUTA: ${nombreTerapeuta.toUpperCase()}`;
        terapeutaCell.fill = { type: 'pattern', pattern: 'solid', fgColor: { argb: colors.azulHeader } };
        terapeutaCell.font = { bold: true, color: { argb: colors.blanco } };
        terapeutaCell.alignment = centerStyle;
        currentRow++;

        // B. Encabezados de Días (Paciente, 1, 2, ..., 31, TOTAL)
        const headerRow = worksheet.getRow(currentRow);
        headerRow.getCell(1).value = "PACIENTE"; // Columna A
        
        // Días 1 al 31
        for (let i = 1; i <= 31; i++) {
            headerRow.getCell(i + 1).value = i;
        }
        headerRow.getCell(33).value = "TOTAL"; // Columna AG (33)

        // Estilo de encabezados
        for (let i = 1; i <= 33; i++) {
            const cell = headerRow.getCell(i);
            cell.font = { bold: true };
            cell.alignment = centerStyle;
            cell.fill = { type: 'pattern', pattern: 'solid', fgColor: { argb: 'FFEEEEEE' } }; // Gris claro
            cell.border = borderStyle;
        }
        
        // Ajustar ancho columna Paciente
        worksheet.getColumn(1).width = 35;
        // Ajustar ancho columnas días
        for (let i = 2; i <= 32; i++) {
            worksheet.getColumn(i).width = 5; 
        }
        worksheet.getColumn(33).width = 12; // Ancho Total

        currentRow++;

        // C. Procesar Matriz de Pacientes para este Terapeuta
        const matrizPacientes = {};
        
        citas.forEach(c => {
            const paciente = c.nombre_paciente;
            if (!matrizPacientes[paciente]) matrizPacientes[paciente] = {};
            
            // Extraer día
            let dia = 0;
            if (c.fecha) {
                const fechaStr = c.fecha.toISOString().split('T')[0]; // YYYY-MM-DD
                dia = parseInt(fechaStr.split('-')[2]);
            }
            if (dia > 0) matrizPacientes[paciente][dia] = c;
        });

        // D. Pintar Filas de Pacientes
        for (const [nombrePac, diasCitas] of Object.entries(matrizPacientes)) {
            const row = worksheet.getRow(currentRow);
            
            // Nombre Paciente
            const cellNombre = row.getCell(1);
            cellNombre.value = nombrePac;
            cellNombre.border = borderStyle;
            cellNombre.alignment = { vertical: 'middle', horizontal: 'left' };

            let totalDinero = 0;

            // Celdas de Días (1 al 31)
            for (let dia = 1; dia <= 31; dia++) {
                const cell = row.getCell(dia + 1);
                const cita = diasCitas[dia];
                
                cell.border = borderStyle;
                cell.alignment = centerStyle;

                if (cita) {
                    const pago = parseFloat(cita.pago || 0);
                    const asis = parseInt(cita.asistencia || 0);
                    totalDinero += pago;

                    cell.value = pago;
                    cell.numFmt = '"$"#,##0'; // Formato moneda sin decimales para ahorrar espacio

                    // COLORES (Lógica idéntica a Flutter)
                    let bgColor = colors.gris;
                    let fontColor = colors.negro;

                    if (asis === 1) { bgColor = colors.rosa; fontColor = colors.negro; }
                    else if (asis === 2) { bgColor = colors.rojo; fontColor = colors.blanco; }
                    else if (asis === 3) { bgColor = colors.naranja; fontColor = colors.blanco; }
                    else if (asis === 4 || asis === 5) { bgColor = colors.verde; fontColor = colors.blanco; }
                    else { bgColor = colors.gris; fontColor = colors.blanco; } // 0 o null

                    cell.fill = { type: 'pattern', pattern: 'solid', fgColor: { argb: bgColor } };
                    cell.font = { color: { argb: fontColor }, size: 9, bold: true };
                }
            }

            // Celda TOTAL
            const cellTotal = row.getCell(33);
            cellTotal.value = totalDinero;
            cellTotal.numFmt = '"$"#,##0';
            cellTotal.font = { bold: true, color: { argb: 'FF000000' } };
            cellTotal.fill = { type: 'pattern', pattern: 'solid', fgColor: { argb: colors.azulTotal } };
            cellTotal.border = borderStyle;
            cellTotal.alignment = centerStyle;

            currentRow++;
        }

        currentRow += 2; // Espacio entre terapeutas
    }

    const filePath = path.join(reportsDir, `${fileName}.xlsx`);
    await workbook.xlsx.writeFile(filePath);
    return filePath;
}

// -----------------------------------------------------------------
// NUEVA FUNCIÓN PARA GENERAR EL REPORTE DE CONTEO EN EXCEL (SIN COLOR NI ESTILO DE TABLA)
// -----------------------------------------------------------------
async function generateServiceCountExcel(data, fileName, filterInfo) {
    const workbook = new ExcelJS.Workbook();
    const worksheet = workbook.addWorksheet('Conteo de Servicios');
    
    // ESTILO DE ENCABEZADO SIMPLE (Solo negrita y centrado)
    const headerStyle = {
        font: { bold: true, color: { argb: 'FF000000' } }, // Texto Negro
        alignment: { vertical: 'middle', horizontal: 'center' }, // Centrado
        // Se omiten bordes y relleno
    };
    
    // ESTILO BASE DE CELDAS DE DATOS SIMPLE (Solo centrado)
    const dataStyleBase = {
        alignment: { vertical: 'middle', horizontal: 'center' }, // Centrado de texto
        font: { color: { argb: 'FF000000' } }, // Texto negro
        // Se omiten bordes y relleno
    };

    // Definición de Columnas con el estilo de encabezado
    worksheet.columns = [
        { header: 'SERVICIO BRINDADO', key: 'Servicio Brindado', width: 35 },
        { header: 'CONTEO NO. PACIENTES', key: 'Conteo No. Pacientes', width: 30 }, 
    ];

    // Fila de Título del Reporte (Fila 1)
    worksheet.mergeCells('A1:B1');
    const titleCell = worksheet.getCell('A1');
    titleCell.value = `REPORTE DE CONTEO: ${filterInfo}`;
    titleCell.font = { bold: true, size: 14, color: { argb: 'FF000000' } };
    titleCell.alignment = { vertical: 'middle', horizontal: 'center' };
    
    worksheet.addRow([]); // Fila vacía (Fila 2)
    
    // Fila de encabezados reales (Fila 3)
    const headerRow = worksheet.addRow(worksheet.columns.map(col => col.header)); 
    
    // Aplicar estilo de encabezado a la fila 3
    headerRow.eachCell({ includeEmpty: false }, (cell) => {
        // Aplicamos el estilo de texto y centrado
        cell.font = headerStyle.font;
        cell.alignment = headerStyle.alignment;
    });

    // Agregar datos y aplicar estilo de datos
    data.forEach((row, index) => {
        const newRow = worksheet.addRow(row);
        
        newRow.eachCell({ includeEmpty: false }, (cell, colNumber) => {
            // Aplicar estilo base (solo centrado)
            cell.font = dataStyleBase.font;
            cell.alignment = dataStyleBase.alignment;
        });
    });
    
    const filePath = path.join(reportsDir, `${fileName}.xlsx`);
    await workbook.xlsx.writeFile(filePath);
    return filePath;
}

// -----------------------------------------------------------
// 📈 RUTA 1: Reporte de Conteo de Pacientes por Servicio (DATA FETCH)
// (CORREGIDA PARA ACEPTAR FILTROS DE FECHA)
// -----------------------------------------------------------
app.get("/reporte-conteo-servicios", async (req, res) => {
    const { type, year, month } = req.query;

    if (!type || !year) {
        return res.status(400).json({ error: "Faltan parámetros 'type' o 'year'." });
    }

    const client = await pool.connect();
    try {
        const conteosBdRows = await queryServiceCountData(client, type, year, month);

        const serviciosRequeridos = [
            'Terapeuta Fisico',
            'Terapeuta Autismo',
            'Terapeuta Lenguaje',
            'Psicologia',
            'Médico'
       ];
        const conteosBd = conteosBdRows.reduce((map, row) => {
            map[row["Servicio Brindado"]] = parseInt(row["Conteo No. Pacientes"]); 
            return map;
        }, {});
        const respuestaFinal = serviciosRequeridos.map(servicio => ({
            "Servicio Brindado": servicio,
            "Conteo No. Pacientes": conteosBd[servicio] || 0
        }));
        res.status(200).json(respuestaFinal);

    } catch (error) {
        console.error("🔥 Error en /reporte-conteo-servicios:", error);
        res.status(500).json({ error: "Error al generar el conteo de servicios", detalle: error.message });
    } finally {
        client.release();
    }
});

// -----------------------------------------------------------
// 📊 RUTA 2: GENERACIÓN DE ARCHIVO DE CONTEO (CORREGIDA PARA NOMBRE CORTO)
// -----------------------------------------------------------
app.post("/generate-service-count-report", async (req, res) => {
    const { reportData, filterInfo } = req.body; 

    if (!reportData || reportData.length === 0) {
        return res.status(400).json({ error: "No se recibieron datos de conteo para generar el archivo." });
    }

    try {
        const cleanFilterName = filterInfo
                                    .toLowerCase()
                                    .replace('/', '_')
                                    .replace(/[^a-z0-9_]/g, ''); 
                                    
        const fileNameBase = `conteo_servicios_${cleanFilterName}`;
        const serverBaseUrl = "http://localhost:3000"; 
        
        await generateServiceCountExcel(reportData, fileNameBase, filterInfo);
        
        const pdfFileName = `${fileNameBase}.pdf`;
        fs.writeFileSync(path.join(reportsDir, pdfFileName), `Documento PDF simulado para el reporte de conteo.`);
        const pdfUrl = `${serverBaseUrl}/reports/${pdfFileName}`;
        const excelUrl = `${serverBaseUrl}/reports/${fileNameBase}.xlsx`;
        console.log(`✅ Reporte de Conteo Excel generado.`);
        res.status(200).json({
            message: "Reporte de conteo generado con éxito.",
            pdfUrl: pdfUrl,
            excelUrl: excelUrl,
        });
    } catch (error) {
        console.error("🔥 Error fatal en /generate-service-count-report:", error);
        res.status(500).json({ error: "Error al generar el reporte de conteo", detalle: error.message });
    }
});

// -----------------------------------------------------------
// 👁️ RUTA: VISTA PREVIA DE DATOS (PREVIEW) - Método GET
// -----------------------------------------------------------
app.get("/preview-report-data", async (req, res) => {
    // 1. Recibimos 'area' desde la URL
    const { type, year, month, area } = req.query; 
    
    if (!type || !year) {
        return res.status(400).json({ error: "Faltan parámetros 'type' o 'year'." });
    }

    const client = await pool.connect();
    try {
        // 2. Pasamos 'area' a la función (el true final es el limitRows)
        const previewData = await queryReportData(client, type, year, month, area, true);
        
        // (Opcional) Si quieres que devuelva array vacío en vez de error 404 cuando no hay datos:
        // if (previewData.length === 0) return res.json([]); 
        
        if (previewData.length === 0) {
            return res.status(404).json({ 
                error: "No se encontraron datos para la vista previa.", 
            });
        }
        res.status(200).json(previewData);

    } catch (error) {
        console.error("🔥 Error en /preview-report-data:", error);
        res.status(500).json({ error: "Error al obtener la vista previa", detalle: error.message });
    } finally {
        client.release();
    }
});

// -----------------------------------------------------------
// 📊 RUTA DE GENERACIÓN DE REPORTES (GENERATE) - Método POST
// -----------------------------------------------------------
app.post("/generate-report", async (req, res) => {
    // 1. Recibimos 'area' del body
    const { type, year, month, area } = req.body;
    
    if (!type || !year) {
        return res.status(400).json({ error: "Faltan parámetros 'type' o 'year'." });
    }

    const client = await pool.connect();
    try {
        // 2. Pasamos 'area' a la función de consulta (y false para no limitar filas)
        // NOTA: Asegúrate de haber actualizado la función queryReportData como te dije arriba
        const reportData = await queryReportData(client, type, year, month, area, false);
        
        if (reportData.length === 0) {
            return res.status(404).json({ 
                error: "No se encontraron datos para generar el reporte.", 
                detalle: "La base de datos no contiene citas en ese periodo/área." 
            });
        }
        
        const monthNames = [
            'enero', 'febrero', 'marzo', 'abril', 'mayo', 'junio',
            'julio', 'agosto', 'septiembre', 'octubre', 'noviembre', 'diciembre'
        ];
        
        // --- 3. LOGICA DE NOMBRE DE ARCHIVO CON ÁREA ---
        let areaPart = "";
        if (area && area !== 'TODOS') {
            // Quitamos espacios: "Terapeuta Fisico" -> "TerapeutaFisico"
            areaPart = `_${area.replace(/\s+/g, '')}`; 
        }

        let fileNameBase;
        let filterInfo;

        if (type === 'mensual' && month) {
            const monthIndex = parseInt(month, 10) - 1;
            const monthName = monthNames[monthIndex];
            fileNameBase = `reporte${areaPart}_${monthName}_${year}`; 
            filterInfo = `${area ? area.toUpperCase() : 'GENERAL'} - ${monthName.toUpperCase()}/${year}`;
        } else if (type === 'anual') {
            fileNameBase = `reporte${areaPart}_anual_${year}`; 
            filterInfo = `${area ? area.toUpperCase() : 'GENERAL'} - ${year}`;
        } else {
            fileNameBase = `reporte_citas_general`; 
            filterInfo = 'General';
        }

        // 🔥 AQUÍ ESTÁ EL CAMBIO CLAVE PARA RAILWAY 🔥
        // Usamos tu URL de producción para que el link sea accesible desde cualquier lado
        const serverBaseUrl = "https://backendcri-production.up.railway.app"; 
        
        // Generamos el archivo físico en la carpeta /reports del servidor
        await generateExcelReport(reportData, fileNameBase, filterInfo);
        
        // Construimos la URL pública de descarga
        const excelUrl = `${serverBaseUrl}/reports/${fileNameBase}.xlsx`;
        
        console.log(`✅ Reporte Excel generado: ${fileNameBase}.xlsx`);
        
        res.status(200).json({
            message: "Reporte generado con éxito.",
            excelUrl: excelUrl, // Flutter recibirá: https://backendcri.../reports/archivo.xlsx
            dataCount: reportData.length,
        });

    } catch (error) {
        console.error("🔥 Error fatal en /generate-report:", error);
        res.status(500).json({ error: "Error al generar el reporte", detalle: error.message });
    } finally {
        client.release();
    }
});;


// -----------------------------------------------------------
// --- RUTA NUEVA: REGISTRAR PERSONAL (ENDPOINT /personal2) ---
// -----------------------------------------------------------
// -----------------------------------------------------------
// --- RUTA: REGISTRAR PERSONAL Y HORARIOS (CON TRANSACCIÓN) ---
// -----------------------------------------------------------
app.post("/personal2", async (req, res) => {
  console.log("🔹 Datos recibidos:", req.body);

  const { nombre, usuario, contra, dias_laboral, funcion } = req.body;
  // dias_laboral llega como string: "Lun,Mar,Mie"

  const client = await pool.connect();

  try {
    // 1. INICIAR TRANSACCIÓN (Todo o nada)
    await client.query('BEGIN');

    // ---------------------------------------------------------
    // PASO A: Insertar el Empleado (Sin los días)
    // ---------------------------------------------------------
    // NOTA: Verifica si en tu base de datos las columnas son 'contra' y 'funcion' 
    // o si son 'password' y 'rol'. Aquí uso lo que mandas desde Flutter.
    const sqlPersonal = `
      INSERT INTO personal (nombre, usuario, contra, funcion)
      VALUES ($1, $2, $3, $4)
      RETURNING id_personal;
    `;
    
    const resPersonal = await client.query(sqlPersonal, [nombre, usuario, contra, funcion]);
    const nuevoId = resPersonal.rows[0].id_personal;
    console.log("✅ Personal creado con ID:", nuevoId);

    // ---------------------------------------------------------
    // PASO B: Procesar los días y guardar en horarios_personal
    // ---------------------------------------------------------
    
    // Mapa para convertir texto a número (Según tu imagen: Lun=1, Mar=2...)
    const mapaDias = {
      "Lun": 1, "Mar": 2, "Mie": 3, "Jue": 4, "Vie": 5, "Sab": 6, "Dom": 7
    };

    // Convertimos "Lun,Mar" en un array ["Lun", "Mar"]
    const listaDias = dias_laboral.split(',');

    for (const diaTexto of listaDias) {
      const diaNumero = mapaDias[diaTexto.trim()]; // Obtenemos el número (ej. 1)

      if (diaNumero) {
        // Insertamos en la tabla de horarios
        // OJO: Estoy poniendo un horario default de 08:00 a 15:00 como en tu imagen.
        // Si quieres que sea dinámico, tendrías que pedir la hora en Flutter.
        const sqlHorario = `
          INSERT INTO horarios_personal (id_personal, dia_semana, hora_inicio_laboral, hora_fin_laboral)
          VALUES ($1, $2, '08:00:00', '15:00:00');
        `;
        await client.query(sqlHorario, [nuevoId, diaNumero]);
      }
    }

    // 2. CONFIRMAR CAMBIOS
    await client.query('COMMIT');
    
    res.status(201).json({ message: "Personal y horarios registrados correctamente" });

  } catch (error) {
    // 3. SI ALGO FALLA, DESHACER TODO (ROLLBACK)
    await client.query('ROLLBACK');
    console.error("🔥 Error en transacción:", error);
    
    // Verificamos si es error de usuario duplicado
    if (error.code === '23505') { // Código PostgreSQL para unique violation
       return res.status(400).json({ message: "El usuario ya existe." });
    }

    res.status(500).json({ message: "Error interno al guardar datos." });
  } finally {
    client.release();
  }
});



//////////////////////////////////////////fin adrian///////////////////////////////////////////////////////////////////


//////////////////////////////////////////inicio entrelazada///////////////////////////////////////////////////////////////////
// -----------------------------------------------------------
// --- RUTA: DOCTOR MANDA A RECEPCIÓN (CORREGIDA) ---
// -----------------------------------------------------------
app.post("/mandar-a-recepcion", async (req, res) => {
  // Nota: Ya no pedimos 'asistencia' para no sobrescribir la que guardaste en bitácora
  const { id_cita, id_paciente, nuevo_motivo } = req.body;

  console.log(`📡 Recibiendo solicitud para Entrelazar Cita ID: ${id_cita}`);

  if (!id_cita || !id_paciente) {
      return res.status(400).json({ error: "Faltan datos obligatorios" });
  }

  const client = await pool.connect();

  try {
    await client.query("BEGIN");

    // 1. Update al Paciente (Motivo Estudio)
    await client.query(
      "UPDATE paciente SET motivo_estudio = $1 WHERE id_paciente = $2",
      [nuevo_motivo, id_paciente]
    );

    // 2. Update a la Cita (Estatus Entrelazada)
    // CORRECCIÓN: Quitamos la coma antes del WHERE y usamos $1 para el ID
    await client.query(
      "UPDATE citas SET estatus = 'Entrelazada', tipo_cita = 'V' WHERE id_cita = $1",
      [id_cita]
    );

    await client.query("COMMIT");
    console.log("✅ ÉXITO: Paciente y Cita actualizados a 'Entrelazada'.");
    res.json({ message: "Paciente enviado a asignación correctamente" });

  } catch (err) {
    await client.query("ROLLBACK");
    console.error("🔥 ERROR SQL en /mandar-a-recepcion:", err.message);
    res.status(500).json({ error: err.message });
  } finally {
    client.release();
  }
});

// -----------------------------------------------------------
// --- 2. RUTA: RECEPCIÓN VER LISTA POR ASIGNAR (Solo hoy) ---
// -----------------------------------------------------------
// --- MODIFICACIÓN: VER TANTO PENDIENTES (P) COMO VALORADAS (V) ---
app.get('/citas-entrelazadas-hoy', async (req, res) => {
  try {
    const query = `
      SELECT 
        c.id_cita, 
        c.hora_inicio, 
        c.id_paciente, 
        c.estatus,
        c.tipo_cita,
        
        -- 👇 CORRECCIÓN AQUÍ: Cambiamos nombre_completo por nombre 👇
        pac.nombre as nombre, 
        
        p.nombre as nombre_medico
      FROM citas c
      JOIN paciente pac ON c.id_paciente = pac.id_paciente
      LEFT JOIN personal p ON c.id_personal = p.id_personal
      WHERE c.fecha = CURRENT_DATE
      AND c.estatus = 'Entrelazada'
      AND c.tipo_cita IN ('P', 'V')
      ORDER BY c.hora_inicio ASC
    `;
    
    const result = await pool.query(query);
    res.json(result.rows);
  } catch (error) {
    console.error("❌ ERROR SQL:", error.message); // Esto nos mostrará el error real en los logs
    res.status(500).json({ error: "Error al obtener citas" });
  }
});

// -----------------------------------------------------------
// --- RUTA: OBTENER INFO DE UN PERSONAL POR ID ---
// -----------------------------------------------------------
app.get("/personal-info/:id", async (req, res) => {
  const { id } = req.params;
  try {
    // Usamos 'funcion AS rol' para que Flutter siempre reciba 'rol'
    const query = "SELECT id_personal, nombre, funcion AS rol FROM personal WHERE id_personal = $1";
    
    const result = await pool.query(query, [id]);
    
    if (result.rows.length === 0) {
      return res.status(404).json({ error: "No existe ese ID" });
    }
    
    res.json(result.rows[0]); // Ahora el JSON tendrá { id_personal: ..., nombre: ..., rol: ... }
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

//////////////////////////////////////////fin entrelazaada///////////////////////////////////////////////////////////////////

// -----------------------------------------------------------
// --- RUTA: MONITOR DE BAJAS (FINAL: CON NOMBRE DE TRATANTE) ---
// -----------------------------------------------------------
app.get("/pacientes-con-faltas", async (req, res) => {
  const { departamento, tipo_programa } = req.query; 

  const client = await pool.connect();
  try {
    let filtroPrograma = "";
    
    // 1. Filtro inteligente según pestaña
    if (tipo_programa === 'valoracion') {
      filtroPrograma = "AND (c.tipo_cita = 'P' OR c.tipo_cita = 'V') AND c.total_val > 1";
    } else {
      filtroPrograma = "AND c.tipo_cita = 'A'";
    }

    const sql = `
      SELECT 
        p.id_paciente,
        p.nombre,
        p.servicio,
        p.telefono,
        
        -- 👇 NUEVO: Traemos el nombre del doctor de la tabla personal
        per.nombre AS nombre_terapeuta,

        -- Datos de la Cita con Incidencia
        c.id_cita,
        c.fecha,
        c.asistencia, 
        c.tipo_cita,
        c.indice_val,
        c.total_val,
        
        -- Observación
        hc.observaciones
        
      FROM citas c
      JOIN paciente p ON c.id_paciente = p.id_paciente
      -- 👇 NUEVO: Unimos con personal para saber quién atendía esa cita
      LEFT JOIN personal per ON c.id_personal = per.id_personal
      LEFT JOIN historial_consultas hc ON c.id_cita = hc.id_cita
      
      WHERE 
        c.asistencia IN (1, 2, 3, 5) 
        AND p.estatus_paciente = 'Activo'
        ${filtroPrograma}
        ${departamento ? "AND c.servicio_area = $1" : ""}
      
      ORDER BY p.nombre ASC, c.fecha DESC;
    `;

    const params = departamento ? [departamento] : [];
    const result = await client.query(sql, params);

    // 3. AGRUPAMIENTO
    const pacientesMap = {};

    result.rows.forEach(row => {
      if (!pacientesMap[row.id_paciente]) {
        pacientesMap[row.id_paciente] = {
          id_paciente: row.id_paciente,
          nombre: row.nombre,
          servicio: row.servicio,
          telefono: row.telefono,
          // 👇 NUEVO: Guardamos el nombre del terapeuta aquí
          // (Si viene null, ponemos 'Sin Asignar')
          nombre_terapeuta: row.nombre_terapeuta || 'Sin Asignar',
          historial: [] 
        };
      }

      pacientesMap[row.id_paciente].historial.push({
        id_cita: row.id_cita,
        fecha: row.fecha,
        asistencia: row.asistencia,
        tipo: row.tipo_cita,
        observacion: row.observaciones,
        info_val: row.total_val > 1 ? `(${row.indice_val}/${row.total_val})` : ""
      });
    });

    res.json(Object.values(pacientesMap));

  } catch (error) {
    console.error("🔥 Error en /pacientes-con-faltas:", error);
    res.status(500).json({ error: "Error al buscar historial" });
  } finally {
    client.release();
  }
});

// -----------------------------------------------------------
// --- RUTA: DETECTOR DE PACIENTES POR FINALIZAR (DESGLOSE TOTAL) ---
// -----------------------------------------------------------
// -----------------------------------------------------------
// --- RUTA: PACIENTES POR FINALIZAR (FINAL: Con Historial Detallado y p.*) ---
// -----------------------------------------------------------
// -----------------------------------------------------------
// --- RUTA: PACIENTES POR FINALIZAR (CORREGIDA Y SIN FILTROS) ---
// -----------------------------------------------------------
app.get("/pacientes-por-finalizar", async (req, res) => {
  const client = await pool.connect();
  try {
    const sql = `
      SELECT 
        p.*,
        c.id_cita, c.fecha, c.hora_inicio, c.asistencia, c.tipo_cita, c.num_programa, c.pago, c.servicio_area,
        per.nombre as nombre_tratante, -- ✅ Aquí SÍ viene de la BD
        hc.observaciones
      FROM citas c
      JOIN paciente p ON c.id_paciente = p.id_paciente
      LEFT JOIN personal per ON c.id_personal = per.id_personal
      LEFT JOIN historial_consultas hc ON c.id_cita = hc.id_cita
      WHERE c.tipo_cita = 'A' AND p.estatus_paciente = 'Activo'
      AND c.num_programa = p.num_programa_actual
      ORDER BY p.nombre ASC, c.fecha DESC;
    `;

    const result = await client.query(sql);

    // --- AGRUPAMIENTO ---
    const pacientesMap = {};

    result.rows.forEach(row => {
      // Si el paciente no existe en el mapa, lo creamos
      if (!pacientesMap[row.id_paciente]) {
        pacientesMap[row.id_paciente] = {
          // Datos del Paciente
          id_paciente: row.id_paciente,
          nombre: row.nombre,
          servicio: row.servicio,
          
          // AQU FALTABA ESTA LÍNEA
          nombre_tratante: row.nombre_tratante, 
          //  Sin esto, Flutter recibe null en la tarjeta principal
          
          telefono: row.telefono,
          domicilio: row.domicilio,
          edad: row.edad,
          fecha_nac: row.fecha_nac,
          sexo: row.sexo,
          curp: row.curp,
          cp: row.cp,
          entidad_fed: row.entidad_fed,
          edo_civil: row.edo_civil,
          escolaridad: row.escolaridad,
          ref_medica: row.ref_medica,
          motivo_estudio: row.motivo_estudio,
          num_programa_actual: row.num_programa_actual,
          programa_actual: row.num_programa,
          historial: [] 
        };
      }

      // Agregamos la cita al historial
      pacientesMap[row.id_paciente].historial.push({
        id_cita: row.id_cita,
        fecha: row.fecha,
        hora: row.hora_inicio,
        asistencia: row.asistencia,
        tratante: row.nombre_tratante,
        observacion: row.observaciones,
        pago: row.pago
      });
    });

    const listaFinal = Object.values(pacientesMap);
    res.json(listaFinal);

  } catch (error) {
    console.error("🔥 Error en /pacientes-por-finalizar:", error);
    res.status(500).json({ error: "Error al buscar historial" });
  } finally {
    client.release();
  }
});
///////////////////////////////////////////////////////////////////////////////////////////////////////////////////////////////////////////
// -----------------------------------------------------------
// --- NUEVA RUTA: Dashboard "CITAS PARA HOY" (tipo 'P') ---
// -----------------------------------------------------------


// -----------------------------------------------------------
// --- RUTA: Dashboard "CITAS PARA HOY" (Filtra P o A) ---
// -----------------------------------------------------------
// -----------------------------------------------------------
// --- RUTA: Dashboard "CITAS PARA HOY" (CORREGIDA Y SINCRONIZADA) ---
// -----------------------------------------------------------
// -----------------------------------------------------------
// --- RUTA: Dashboard "CITAS PARA HOY" (CORREGIDA: Filtra por CITA) ---
// -----------------------------------------------------------
app.get("/citas-hoy-primera-vez", async (req, res) => {
  const { especialidad, tipo } = req.query;
  const tipoFiltro = tipo || 'P'; 

  if (!especialidad) return res.status(400).json({ error: "Falta especialidad" });

  const client = await pool.connect();
  try {

    // ---------------------------------------------------------
    // CONSULTA 1: Profesionales (CORREGIDA LA FECHA AQUÍ 👇)
    // ---------------------------------------------------------
    const sqlProfesionalesDirecta = `
      SELECT DISTINCT
        pe.id_personal,
        pe.nombre AS nombre_profesional,
        pe.funcion AS especialidad
      FROM personal pe
      JOIN citas c ON pe.id_personal = c.id_personal
      WHERE
        -- 👇 AQUÍ ESTABA EL ERROR, AHORA USA HORA MÉXICO 👇
        c.fecha = (NOW() AT TIME ZONE 'America/Mexico_City')::date
        AND unaccent(TRIM(c.servicio_area)) ILIKE unaccent($2) 
        AND (
            ($1 = 'P' AND (c.asistencia IS NULL OR c.asistencia = 0))
            OR
            ($1 = 'A' AND c.asistencia > 0)
        )
    `;

    const resProfesionales = await client.query(sqlProfesionalesDirecta, [tipoFiltro, especialidad]);
    const profesionales = resProfesionales.rows;

    if (profesionales.length === 0) return res.json([]);

    // ---------------------------------------------------------
    // CONSULTA 2: Pacientes (Esta ya estaba bien)
    // ---------------------------------------------------------
    const idsProfesionales = profesionales.map(p => p.id_personal);

    const sqlPacientes = `
      SELECT
        c.id_cita, c.id_personal, c.id_paciente, c.asistencia, c.pago, c.indice_val, c.total_val,
        pa.nombre AS nombre_paciente,
        
        pa.tipo_paciente, 
        
        pa.motivo_estudio, pa.servicio, pa.fecha_nac, pa.domicilio,
        pa.telefono, pa.tel_domicilio, pa.edad, pa.sexo, pa.ocupacion,
        edo_civil, pa.escolaridad, pa.entidad_fed, pa.cp, pa.num_consultorio,
        
        c.servicio_area,
        TO_CHAR(c.hora_inicio, 'HH24:MI') AS hora_inicio,
        TO_CHAR(c.hora_fin, 'HH24:MI') AS hora_fin,
        c.tipo_cita
      FROM citas c
      JOIN paciente pa ON c.id_paciente = pa.id_paciente
      WHERE
        c.id_personal = ANY($1::int[])
        AND c.fecha = (NOW() AT TIME ZONE 'America/Mexico_City')::date
        AND unaccent(TRIM(c.servicio_area)) ILIKE unaccent($3)
        AND (
            ($2 = 'P' AND (c.asistencia IS NULL OR c.asistencia = 0))
            OR
            ($2 = 'A' AND c.asistencia > 0)
        )
      ORDER BY c.hora_inicio;
    `;
    
    const resPacientes = await client.query(sqlPacientes, [idsProfesionales, tipoFiltro, especialidad]);
    
    // --- FUSIÓN DE DATOS ---
    const pacientes = resPacientes.rows;
    const resultadoFinal = profesionales.map(prof => {
      const pacientesAsignados = pacientes.filter(pac => pac.id_personal === prof.id_personal);
      return {
        ...prof,
        conteo_pacientes: pacientesAsignados.length,
        pacientes: pacientesAsignados
      };
    });
    
    res.json(resultadoFinal);

  } catch (error) {
    console.error("Error en citas-hoy-primera-vez:", error);
    res.status(500).json({ error: "Error al obtener citas" });
  } finally {
    client.release();
  }
});
/***********************************************************************************************************************************************************/



// -----------------------------------------------------------
// --- RUTA DE DIRECTORIO / BÚSQUEDA PERSONAL ---
// -----------------------------------------------------------
// 🔍 BUSCAR PERSONAL (VERSIÓN ROBUSTA COPIADA DE HORARIOS)
// 🔍 BUSCAR PERSONAL (CORREGIDO: SIN COLUMNA ESTATUS)
app.get("/buscar-personal", async (req, res) => {
  const { query, area } = req.query; 
  const client = await pool.connect();

  try {
    // 👇 CAMBIO AQUÍ: Quitamos "WHERE estatus = 'Activo'"
    // Usamos 1=1 para poder concatenar los AND sin problemas
    let sql = "SELECT id_personal, nombre, funcion AS especialidad FROM personal WHERE 1=1";
    let params = [];
    let paramCounter = 1;

    // 1. FILTRO POR ÁREA (TRIM + UNACCENT + ILIKE)
    if (area && area !== 'Todos' && area !== '') {
      sql += ` AND unaccent(TRIM(funcion)) ILIKE unaccent($${paramCounter})`;
      params.push(`%${area.trim()}%`); 
      paramCounter++;
    }

    // 2. FILTRO POR NOMBRE
    if (query && query.trim() !== "") {
      sql += ` AND unaccent(TRIM(nombre)) ILIKE unaccent($${paramCounter})`;
      params.push(`%${query.trim()}%`);
      paramCounter++;
    }

    sql += " ORDER BY funcion, nombre;";

    const result = await client.query(sql, params);
    res.json(result.rows);

  } catch (error) {
    console.error("Error buscando personal:", error);
    res.status(500).json([]);
  } finally {
    client.release();
  }
});


// ---------------------------
// RUTA DE PRUEBA DE DB
// ---------------------------
app.get("/test-db", async (req, res) => {
  try {
    await pool.query("CREATE EXTENSION IF NOT EXISTS unaccent;"); // Asegura que unaccent exista
    const result = await pool.query("SELECT 1+1 AS prueba");
    res.json({ resultado: result.rows[0].prueba });
  } catch (error) {
    res.status(500).json({ error: error.message });
  }
});

// ---------------------------
// RUTA DE LOGIN (ACTUALIZADA)
// ---------------------------
app.post('/login', async (req, res) => {
  const { usuario, contra } = req.body;
  
  if (!usuario || !contra) {
    return res.status(400).json({ message: "El usuario y la contraseña son obligatorios." });
  }

  try {
    const result = await pool.query('SELECT * FROM personal WHERE usuario = $1', [usuario]);
    
    if (result.rows.length === 0) {
      return res.status(404).json({ message: "Usuario no encontrado." });
    }
    
    const user = result.rows[0];
    
    // --- VALIDACIÓN HÍBRIDA (Texto Plano + Bcrypt) ---
    // 1. Primero intentamos comparación directa (para tus usuarios manuales "1234")
    let passwordMatch = (contra === user.contra);

    // 2. Si no coincidió directo, intentamos con Bcrypt (para usuarios nuevos)
    if (!passwordMatch) {
       try {
         passwordMatch = await bcrypt.compare(contra, user.contra);
       } catch (e) {
         // Si 'user.contra' no es un hash válido de bcrypt, esto tronaría. 
         // Lo atrapamos y simplemente decimos que no coincidió.
         passwordMatch = false; 
       }
    }

    if (!passwordMatch) {
      return res.status(401).json({ message: "Contraseña incorrecta." });
    }
    
    // --- DATOS DE SESIÓN ---
    res.status(200).json({
      message: 'Login exitoso',
      // Usamos 'funcion' como rol porque así está en tu BD
      rol: user.funcion, 
      id_personal: user.id_personal, 
      nombre: user.nombre            
    });

  } catch (error) {
    console.error("🔥 ERROR EN LOGIN:", error);
    res.status(500).json({ message: "Error interno del servidor." });
  }
});

// ---------------------------
// OBTENER PERSONAL (Esta está bien)
// ---------------------------
app.get("/personal", async (req, res) => {
  console.log("🔹 GET /personal fue llamado");
  try {
    const result = await pool.query("SELECT * FROM personal ORDER BY id_personal ASC");
    res.json(result.rows);
  } catch (error) {
    console.error("🔥 ERROR AL OBTENER PERSONAL:", error);
    res.status(500).json({ error: "Error al obtener personal" });
  }
});

// --- Función helper para convertir 'HH:MI' a minutos (ej. '08:30' -> 510) ---
const timeToMinutes = (timeStr) => {
  if (!timeStr) return 0;
  const [h, m] = timeStr.split(':').map(Number);
  return (h * 60) + m;
};


// -----------------------------------------------------------
// --- RUTA DE HORARIOS (VERSIÓN FINAL CON LÓGICA 'P' vs 'A') ---
// -----------------------------------------------------------
// --- RUTA DE HORARIOS (MEJORADA: Acepta idPersonal O especialidad) ---
// -----------------------------------------------------------
// --- RUTA DE HORARIOS (VERSIÓN FINAL CON LÓGICA DE COLORES) ---
// -----------------------------------------------------------
// -----------------------------------------------------------
// --- RUTA DE HORARIOS (CORREGIDA: Acepta nombreBusqueda) ---
// -----------------------------------------------------------
app.get("/horarios-disponibles", async (req, res) => {
  // 1. Recibimos 'nombreBusqueda'
  const { fecha, especialidad, contexto, idPersonal, nombreBusqueda } = req.query;

  // 2. CORRECCIÓN EN VALIDACIÓN:
  // Ahora permitimos pasar si trae 'nombreBusqueda'
  if (!fecha || (!especialidad && !idPersonal && !nombreBusqueda)) {
    return res.status(400).json({ error: "Faltan parámetros (fecha y especialidad, idPersonal o nombreBusqueda)" });
  }

  // Lógica de Día de Semana
  const [year, month, day] = fecha.split('-').map(Number);
  const fechaUTC = new Date(Date.UTC(year, month - 1, day));
  const diaSemanaNum = fechaUTC.getUTCDay();

  if (diaSemanaNum === 0 || diaSemanaNum === 6) {
    return res.json([]); // Fin de semana
  }

  const client = await pool.connect();
  try {
    console.log("\n--- 🕵️‍♂️ NUEVA PETICIÓN DE HORARIOS ---");
    console.log(`Fecha: ${fecha} | Especialidad: ${especialidad} | Nombre: ${nombreBusqueda}`);

    let sqlPlantilla;
    let paramsPlantilla;

    // 3. CORRECCIÓN EN LÓGICA SQL:
    if (idPersonal) {
      // CASO 1: Búsqueda por ID (Prioridad máxima)
      console.log(">> Buscando por ID Personal");
      sqlPlantilla = `
        SELECT p.id_personal, p.nombre, p.funcion AS especialidad,
        h.hora_inicio_laboral, h.hora_fin_laboral
        FROM personal p
        JOIN horarios_personal h ON p.id_personal = h.id_personal
        WHERE p.id_personal = $1 AND h.dia_semana = $2;
      `;
      paramsPlantilla = [idPersonal, diaSemanaNum];

    } else if (nombreBusqueda && nombreBusqueda.trim() !== "") {
      // CASO 2: Búsqueda por NOMBRE (Excepción Edad Temprana)
      // --- ¡ESTE BLOQUE FALTABA EN TU CÓDIGO! ---
      console.log(">> Buscando por NOMBRE (Excepción)");
      sqlPlantilla = `
        SELECT p.id_personal, p.nombre, p.funcion AS especialidad,
        h.hora_inicio_laboral, h.hora_fin_laboral
        FROM personal p
        JOIN horarios_personal h ON p.id_personal = h.id_personal
        WHERE unaccent(p.nombre) ILIKE unaccent($1) AND h.dia_semana = $2;
      `;
      // Usamos ILIKE y % % para buscar coincidencias parciales
      paramsPlantilla = [`%${nombreBusqueda}%`, diaSemanaNum];

    } else {
      // CASO 3: Búsqueda por DEPARTAMENTO (Normal)
      console.log(">> Buscando por ESPECIALIDAD");
      sqlPlantilla = `
        SELECT p.id_personal, p.nombre, p.funcion AS especialidad,
        h.hora_inicio_laboral, h.hora_fin_laboral
        FROM personal p
        JOIN horarios_personal h ON p.id_personal = h.id_personal
        WHERE unaccent(TRIM(p.funcion)) ILIKE unaccent($1) AND h.dia_semana = $2;
      `;
      paramsPlantilla = [especialidad, diaSemanaNum];
    }

    const resPlantilla = await client.query(sqlPlantilla, paramsPlantilla);
    const profesionales = resPlantilla.rows;

    if (profesionales.length === 0) {
      console.log("🕵️‍♂️ RESULTADO: No se encontraron profesionales.");
      return res.json([]);
    }
    
    // --- EL RESTO DEL CÓDIGO DE HUECOS SIGUE IGUAL (Lo pego aquí para que copies todo junto) ---
    
    const sqlCitas = `
      SELECT id_personal, TO_CHAR(hora_inicio, 'HH24:MI') AS hora_inicio,
             TO_CHAR(hora_fin, 'HH24:MI') AS hora_fin, tipo_cita
      FROM citas
      WHERE fecha = $1;
    `;
    const resCitas = await client.query(sqlCitas, [fecha]);

    const citasOcupadas = {};
    resCitas.rows.forEach(cita => {
      if (!citasOcupadas[cita.id_personal]) {
        citasOcupadas[cita.id_personal] = [];
      }
      citasOcupadas[cita.id_personal].push({
        inicio: timeToMinutes(cita.hora_inicio),
        fin: timeToMinutes(cita.hora_fin),
        tipo: cita.tipo_cita
      });
    });

    const resultadoFinal = [];
    const duracionSlot = 30;

    for (const prof of profesionales) {
      const agendaDelDia = [];
      const [inicioH, inicioM] = prof.hora_inicio_laboral.split(':').map(Number);
      const [finH, finM] = prof.hora_fin_laboral.split(':').map(Number);

      let horaActual = inicioH;
      let minActual = inicioM;
      const rangosOcupados = citasOcupadas[prof.id_personal] || [];

      while (horaActual < finH || (horaActual === finH && minActual < finM)) {
        const horaFormateada = `${String(horaActual).padStart(2, '0')}:${String(minActual).padStart(2, '0')}`;
        let finSlotM = minActual + duracionSlot;
        let finSlotH = horaActual;
        if (finSlotM >= 60) { finSlotM -= 60; finSlotH += 1; }
        if (finSlotH > finH || (finSlotH === finH && finSlotM > finM)) break;

        const horaFinSlotFormateada = `${String(finSlotH).padStart(2, '0')}:${String(finSlotM).padStart(2, '0')}`;
        let totalCitasEnSlot = 0;
        let hayCitaTipoP = false;
        const slotInicioMin = timeToMinutes(horaFormateada);
        const slotFinMin = timeToMinutes(horaFinSlotFormateada);

        for (const rango of rangosOcupados) {
          if (slotInicioMin < rango.fin && slotFinMin > rango.inicio) {
            totalCitasEnSlot++;
            if (rango.tipo === 'P' || rango.tipo === 'V') hayCitaTipoP = true;
          }
        }

        let tipoSlot = 'libre';
        if (hayCitaTipoP) tipoSlot = 'P';
        else if (totalCitasEnSlot > 0) tipoSlot = 'A';

        let estaDisponible = true;
        if (contexto === 'primera_vez') {
          estaDisponible = (totalCitasEnSlot === 0);
        } else if (contexto === 'programa') {
          estaDisponible = (!hayCitaTipoP && totalCitasEnSlot < 3);
        } else {
          estaDisponible = true; 
        }

        agendaDelDia.push({
          hora_inicio: horaFormateada,
          hora_fin: horaFinSlotFormateada,
          disponible: estaDisponible,
          total_citas: totalCitasEnSlot,
          tipo_slot: tipoSlot
        });
        horaActual = finSlotH;
        minActual = finSlotM;
      }
      resultadoFinal.push({
        id: prof.id_personal.toString(),
        nombre: prof.nombre,
        especialidad: prof.especialidad,
        agenda_del_dia: agendaDelDia
      });
    }

    res.json(resultadoFinal);

  } catch (error) {
    console.error("🔥 Error en /horarios-disponibles:", error);
    res.status(500).json({ error: 'Error interno del servidor' });
  } finally {
    client.release();
  }
});


// -----------------------------------------------------------
// --- RUTA CREAR CITA (Correcta) ---
// -----------------------------------------------------------
// -----------------------------------------------------------
// --- RUTA CREAR CITA (Ahora lee num_programa desde 'paciente') ---
// -----------------------------------------------------------

// -----------------------------------------------------------
// --- RUTA CREAR CITA (CORREGIDA: Evita duplicados) ---
// -----------------------------------------------------------
// -----------------------------------------------------------
// --- RUTA CREAR CITA (CORREGIDA: Actualiza Motivo y Servicio) ---
// -----------------------------------------------------------
// -----------------------------------------------------------
// --- RUTA CREAR CITA (VERSIÓN MAESTRA FINAL) ---
// -----------------------------------------------------------
app.post("/crear-cita", async (req, res) => {
  const { paciente, cita } = req.body;

  // 🕵️‍♂️ ZONA DE DEBUG: Para ver en los logs de Railway qué está llegando realmente
  console.log("-----------------------------------------");
  console.log("📢 /crear-cita: RECIBIENDO SOLICITUD");
  if (cita) console.log("👉 Dato en CITA.num_programa:", cita.num_programa);
  if (paciente) console.log("👉 Dato en PACIENTE.num_programa_actual:", paciente.num_programa_actual);
  console.log("-----------------------------------------");

  // 1. VALIDACIÓN BÁSICA
  if (!paciente || !cita || !paciente.nombre || !cita.id_personal || !cita.fecha || !cita.hora_inicio) {
    console.error("❌ Faltan datos obligatorios en la solicitud.");
    return res.status(400).json({ error: "Faltan datos del paciente o de la cita" });
  }

  // 2. DETERMINAR EL NIVEL (PROGRAMA)
  // Aquí está la magia: Busca en orden de prioridad.
  // Primero en la CITA (lo nuevo), luego en PACIENTE (respaldo), y si no hay nada, usa 1.
  const numPrograma = cita.num_programa || paciente.num_programa || paciente.num_programa_actual || 1;
  
  console.log(`✅ NIVEL DETERMINADO PARA GUARDAR: ${numPrograma}`);

  const client = await pool.connect();

  try {
    await client.query("BEGIN"); // Iniciamos transacción
    
    let nuevoPacienteId;

    // --- 3. GESTIÓN DEL PACIENTE (Crear o Actualizar) ---
    if (paciente.id_paciente) {
        // CASO A: PACIENTE EXISTENTE (Referencia / Reagendado)
        console.log(`🔄 Actualizando Paciente ID: ${paciente.id_paciente} (Reagendado/Cambio)`);
        nuevoPacienteId = paciente.id_paciente;

        // Actualizamos datos clave incluyendo el motivo y servicio nuevo
        const sqlUpdatePac = `
              UPDATE paciente SET
                domicilio = $1, 
                telefono = $2, 
                edad = $3,
                motivo_estudio = $4,  -- Nuevo Motivo
                servicio = $5,        -- Nuevo Servicio
                num_programa_actual = $6 -- Aseguramos que el paciente tenga el nivel actualizado
              WHERE id_paciente = $7
        `;
        
        await client.query(sqlUpdatePac, [
            paciente.domicilio, 
            paciente.telefono, 
            paciente.edad,
            paciente.motivo_estudio, 
            paciente.servicio,       
            numPrograma,             // Actualizamos también su etiqueta en la tabla paciente
            nuevoPacienteId 
        ]);

    } else {
        // CASO B: NUEVO INGRESO (Paciente virgen en el sistema)
        console.log("🆕 Registrando Paciente Nuevo...");
        const sqlInsertPaciente = `
          INSERT INTO paciente (
              nombre, edad, fecha_nac, entidad_fed, curp, domicilio, 
              cp, telefono, sexo, edo_civil, escolaridad, ref_medica, 
              servicio, motivo_estudio, estatus_paciente, num_programa_actual
          )
          VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9, $10, $11, $12, $13, $14, 'Activo', $15)
          RETURNING id_paciente; 
        `;
        
        const p = paciente;
        const valores = [
            p.nombre, p.edad, p.fecha_nac, p.entidad_fed, p.curp, p.domicilio, 
            p.cp, p.telefono, p.sexo, p.edo_civil, p.escolaridad, p.ref_medica, 
            p.servicio, p.motivo_estudio, 
            numPrograma // Guardamos el nivel inicial (usualmente 1)
        ];

        const pacienteResult = await client.query(sqlInsertPaciente, valores);
        nuevoPacienteId = pacienteResult.rows[0].id_paciente;
    }

    // --- 4. INSERTAR LA CITA (Con el número de programa correcto) ---
    const sqlInsertCita = `
      INSERT INTO citas (
          id_paciente, id_personal, fecha, hora_inicio, hora_fin, 
          servicio_area, estatus, tipo_cita, num_programa, indice_val, total_val
      )
      VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9, 1, 1);
    `;

    const citaValues = [
      nuevoPacienteId,    // $1
      cita.id_personal,   // $2
      cita.fecha,         // $3
      cita.hora_inicio,   // $4
      cita.hora_fin,      // $5
      paciente.servicio,  // $6 (Area destino)
      'Agendada',         // $7
      'P',                // $8
      numPrograma         // $9 (AQUI ENTRA EL 2, 3, etc.)
    ];

    await client.query(sqlInsertCita, citaValues);
    console.log(`🎉 ÉXITO: Cita creada correctamente con Nivel ${numPrograma}.`);

    await client.query("COMMIT"); // Confirmamos cambios
    res.status(201).json({
      message: "Cita creada exitosamente",
      id_paciente: nuevoPacienteId,
    });

  } catch (err) {
    await client.query("ROLLBACK"); // Si algo falla, deshacemos todo
    console.error("🔥 Error CRÍTICO en POST /crear-cita:", err);
    res.status(500).json({ error: "Error interno del servidor al crear cita." });
  } finally {
    client.release();
  }
});


// -----------------------------------------------------------
// --- NUEVA RUTA: Confirmar y Guardar Programa de Citas 'A' ---
// -----------------------------------------------------------
// -----------------------------------------------------------
// --- RUTA CORREGIDA: Confirmar Programa (Hereda num_programa) ---
// -----------------------------------------------------------
app.post("/confirmar-programa", async (req, res) => {
  const { idCitaP, idPaciente, idPersonal, sesiones, asistencia } = req.body;

  if (!idCitaP || !idPaciente || !idPersonal || !sesiones || sesiones.length === 0) {
    return res.status(400).json({ error: "Faltan datos para confirmar el programa" });
  }

  const client = await pool.connect();

  try {
    await client.query("BEGIN");
    
    // --- PASO 0: AVERIGUAR EL NÚMERO DE PROGRAMA DE LA CITA ORIGEN ---
    // Buscamos en la base de datos: "¿En qué programa va esta cita P?"
    const sqlCheckPrograma = `SELECT num_programa FROM citas WHERE id_cita = $1`;
    const resPrograma = await client.query(sqlCheckPrograma, [idCitaP]);
    
    // Si por alguna razón no tiene, asumimos 1. Si tiene (ej. 2), usamos ese.
    const programaActual = resPrograma.rows.length > 0 ? resPrograma.rows[0].num_programa : 1;
    
    console.log(`\n--- 🕵️‍♂️ CONFIRMANDO PROGRAMA ---`);
    console.log(`Heredando num_programa: ${programaActual}`);

    // --- PASO 1: Actualizar la cita 'P' original ---
    const sqlUpdate = `
      UPDATE citas 
      SET 
        tipo_cita = 'V',
        estatus = 'Realizada',
        asistencia = $1
      WHERE id_cita = $2;
    `;
    await client.query(sqlUpdate, [asistencia || 4, idCitaP]);

    // --- PASO 2: Insertar las nuevas citas 'A' (CON EL NÚMERO HEREDADO) ---
    
    // Obtener servicio del paciente
    const resPaciente = await client.query('SELECT servicio FROM paciente WHERE id_paciente = $1', [idPaciente]);
    const servicioArea = resPaciente.rows[0].servicio;

    const valuesStrings = [];
    const valuesParams = [];
    let paramIndex = 1;

    sesiones.forEach(cita => {
      valuesStrings.push(`($${paramIndex++}, $${paramIndex++}, $${paramIndex++}, $${paramIndex++}, $${paramIndex++}, $${paramIndex++}, $${paramIndex++}, $${paramIndex++}, $${paramIndex++})`);
      valuesParams.push(
        idPaciente,   // $1
        idPersonal,   // $2
        cita.fecha,   // $3
        cita.hora_inicio, // $4
        cita.hora_fin,    // $5
        servicioArea, // $6
        'Agendada',   // $7
        'A',          // $8
        programaActual // $9 <--- ¡AQUÍ USAMOS EL NÚMERO HEREDADO (2, 3...)!
      );
    });

    const sqlInsert = `
      INSERT INTO citas (
        id_paciente, id_personal, fecha, hora_inicio, hora_fin, 
        servicio_area, estatus, tipo_cita, num_programa
      ) VALUES ${valuesStrings.join(', ')};
    `;

    await client.query(sqlInsert, valuesParams);

    await client.query("COMMIT");
    console.log(`✅ Programa #${programaActual} confirmado exitosamente.`);
    res.status(201).json({ message: "Programa de citas creado exitosamente" });

  } catch (err) {
    await client.query("ROLLBACK");
    console.error("🔥 Error en POST /confirmar-programa:", err);
    res.status(500).json({ error: "Error interno del servidor" });
  } finally {
    client.release();
  }
});



// -----------------------------------------------------------
// --- RUTA: Visualizar Programa de Citas (CORREGIDA: Acepta 'A' y 'P' Bloque) ---
// -----------------------------------------------------------
app.get("/programa-paciente", async (req, res) => {
  const { idPaciente } = req.query;

  if (!idPaciente) {
    return res.status(400).json({ error: "Falta el ID del paciente" });
  }

  const client = await pool.connect();
  try {
    console.log(`\n--- 🕵️‍♂️ PETICIÓN: /programa-paciente ---`);
    console.log(`Buscando programa futuro para id_paciente: ${idPaciente}`);

    const sqlPrograma = `
      SELECT
        c.id_cita,
        c.fecha,
        TO_CHAR(c.hora_inicio, 'HH24:MI') AS hora_inicio,
        TO_CHAR(c.hora_fin, 'HH24:MI') AS hora_fin,
        pe.nombre AS nombre_terapeuta,
        c.servicio_area,
        c.tipo_cita,
        c.indice_val, 
        c.total_val
      FROM citas c
      JOIN personal pe ON c.id_personal = pe.id_personal
      WHERE
        c.id_paciente = $1
        AND c.fecha >= CURRENT_DATE  -- Solo futuras (o de hoy en adelante)
        
        -- AQUÍ ESTÁ LA CORRECCIÓN:
        -- Aceptamos 'A' (Tratamiento) O 'P' (Valoración si es parte de un bloque)
        AND (
           c.tipo_cita = 'A' 
           OR 
           (c.tipo_cita = 'P' AND c.total_val > 1)
        )
        
      ORDER BY
        c.fecha ASC, c.hora_inicio ASC;
    `;

    const resPrograma = await client.query(sqlPrograma, [idPaciente]);

    if (resPrograma.rows.length === 0) {
      console.log("🕵️‍♂️ RESULTADO: No se encontraron citas futuras.");
    } else {
      console.log(`🕵️‍♂️ RESULTADO: ${resPrograma.rows.length} citas encontradas.`);
    }

    res.json(resPrograma.rows);

  } catch (error) {
    console.error("🔥 Error en /programa-paciente:", error);
    res.status(500).json({ error: 'Error interno del servidor' });
  } finally {
    client.release();
  }
});

// -----------------------------------------------------------
// --- RUTA ACTUALIZADA: Actualizar Asistencia + Cobro ---
// -----------------------------------------------------------
// -----------------------------------------------------------
// --- RUTA: ACTUALIZAR ASISTENCIA, PAGO Y TIPO DE PACIENTE ---
// -----------------------------------------------------------
// -----------------------------------------------------------
// --- RUTA MAESTRA: COBRO + ASISTENCIA + TIPO + NOTA ---
// -----------------------------------------------------------
app.patch('/actualizar-asistencia', async (req, res) => {
  const { id_cita, asistencia, monto_pago, tipo_paciente, observaciones } = req.body;

  if (!id_cita || !asistencia) {
    return res.status(400).json({ error: "Faltan datos obligatorios" });
  }

  const client = await pool.connect();
  try {
    await client.query('BEGIN'); 

    // ======================================================
    // ✅ PARTE 1: ACTUALIZACIÓN INTELIGENTE DE ESTATUS
    // ======================================================
    const sqlCita = `
      UPDATE citas 
      SET 
        asistencia = $1,
        pago = $2,
        
        -- 👇👇👇 AQUÍ ESTÁ LA LÓGICA QUE FALTABA 👇👇👇
        estatus = CASE 
            -- 1. Si es Primera Vez (P) y es ÚNICA (1 de 1) -> 'Realizada'
            WHEN tipo_cita = 'P' AND total_val = 1 THEN 'Realizada'
            
            -- 2. Todo lo demás (Tratamiento 'A' o Valoración Bloque 'P' 1 de 3) -> 'Finalizada'
            ELSE 'Finalizada'
        END

      WHERE id_cita = $3
      RETURNING id_paciente; 
    `;
    
    const montoFinal = monto_pago || 0;
    
    // Ejecutamos el query corregido
    const resCita = await client.query(sqlCita, [asistencia, montoFinal, id_cita]);

    if (resCita.rowCount === 0) {
      throw new Error("No se encontró la cita");
    }

    const idPaciente = resCita.rows[0].id_paciente;

    // ======================================================
    // ✅ PARTE 2: Tipo de Paciente (Igual que antes)
    // ======================================================
    if (tipo_paciente && idPaciente) {
      const sqlPaciente = `UPDATE paciente SET tipo_paciente = $1 WHERE id_paciente = $2`;
      await client.query(sqlPaciente, [tipo_paciente, idPaciente]);
    }

    // ======================================================
    // ✅ PARTE 3: Historial / Notas (Igual que antes)
    // ======================================================
    if (observaciones !== undefined) {
      const checkSql = `SELECT id_historial FROM historial_consultas WHERE id_cita = $1`;
      const checkResult = await client.query(checkSql, [id_cita]);

      if (checkResult.rowCount > 0) {
        const updateHistorial = `UPDATE historial_consultas SET observaciones = $1 WHERE id_cita = $2`;
        await client.query(updateHistorial, [observaciones, id_cita]);
      } else {
        const insertHistorial = `INSERT INTO historial_consultas (id_cita, id_paciente, observaciones) VALUES ($1, $2, $3)`;
        await client.query(insertHistorial, [id_cita, idPaciente, observaciones]);
      }
    }

    await client.query('COMMIT'); 
    res.json({ message: "Asistencia y Estatus actualizados correctamente" });

  } catch (error) {
    await client.query('ROLLBACK');
    console.error("🔥 Error en actualizar-asistencia:", error);
    res.status(500).json({ error: "Error: " + error.message });
  } finally {
    client.release();
  }
});

// -----------------------------------------------------------
// --- RUTA: IMPREVISTOS DEFINITIVA (Faltas + Olvidos + Check de Recuperación) ---
// -----------------------------------------------------------
app.get("/pacientes-imprevistos", async (req, res) => {
  const client = await pool.connect();
  try {
    const sql = `
      SELECT 
        p.*, 
        c.asistencia,
        c.fecha as fecha_cita,
        c.hora_inicio,
        per.nombre as nombre_tratante,
        c.tipo_cita, 
        c.id_cita,
        c.num_programa,
        c.servicio_area,
        
        -- Etiqueta para el Front: ¿Fue falta o fue error de dedo?
        CASE 
            WHEN c.asistencia = 0 THEN 'Sin Estatus (Olvido)'
            ELSE 'Falta/Cancelación'
        END as motivo_detalle,

        (SELECT COUNT(*) > 0 FROM citas h WHERE h.id_paciente = p.id_paciente AND h.asistencia = 4) as tiene_historial,
        (SELECT hc.observaciones FROM historial_consultas hc WHERE hc.id_cita = c.id_cita LIMIT 1) as observaciones

      FROM citas c
      JOIN paciente p ON c.id_paciente = p.id_paciente
      JOIN personal per ON c.id_personal = per.id_personal
      
      WHERE 
        p.estatus_paciente = 'Activo'
        
        -- 1. SOLO PRIMERA VEZ / VALORACIÓN ÚNICA
        AND (c.tipo_cita = 'V' OR c.tipo_cita = 'P') 
        AND c.indice_val = 1 
        AND c.total_val = 1 

        -- 2. AQUÍ ESTÁ TU REGLA DEL "OLVIDO" 👇
        -- Atrapa si tiene falta explicita OR si es Fantasma (0 y fecha pasada)
        AND (
            c.asistencia IN (1, 2, 3)
            OR 
            (c.asistencia = 0 AND c.fecha < CURRENT_DATE) -- <--- ¡AQUÍ ESTÁ!
        )

        -- 3. EL PERDÓN (Solo si la historia continuó)
        -- Si después de ese error/falta, el paciente ya tuvo otra cita (4)
        -- o ya tiene una nueva agendada, entonces bórralo de la lista.
        AND NOT EXISTS (
            SELECT 1 FROM citas posterior 
            WHERE posterior.id_paciente = c.id_paciente 
            AND posterior.fecha > c.fecha  -- Buscamos citas DESPUÉS del error
            AND (
                posterior.asistencia = 4 -- Ya vino
                OR posterior.estatus IN ('Agendada', 'Pendiente', 'Confirmada') -- Ya reagendó
                OR posterior.asistencia = 0 -- Ya tiene una pendiente
            )
            AND posterior.estatus NOT IN ('Cancelada', 'Baja')
        )

      ORDER BY c.fecha DESC;
    `;
    const result = await client.query(sql);
    res.json(result.rows);
  } catch (error) {
    console.error("Error en /pacientes-imprevistos:", error);
    res.status(500).json([]);
  } finally {
    client.release();
  }
});

// -----------------------------------------------------------
// --- RUTA CORREGIDA: FINALIZAR PACIENTE (Alta o Baja) ---
// -----------------------------------------------------------
// -----------------------------------------------------------
// --- RUTA CORREGIDA: FINALIZAR PACIENTE (Baja + Limpieza de Agenda) ---
// -----------------------------------------------------------
app.patch("/finalizar-paciente", async (req, res) => {
  const { idPaciente, estatus } = req.body;

  console.log(`\n--- 🕵️‍♂️ PROCESO DE BAJA/ALTA ---`);
  console.log(`ID Paciente: ${idPaciente} | Nuevo Estatus: ${estatus}`);

  if (!idPaciente || !estatus) {
    return res.status(400).json({ error: "Faltan datos (idPaciente o estatus)" });
  }

  const client = await pool.connect();
  try {
    await client.query('BEGIN'); // Iniciamos transacción para que todo sea seguro

    // 1. ACTUALIZAR EL ESTATUS DEL PACIENTE (Lo que ya hacías)
    const sqlUpdatePaciente = `
      UPDATE paciente 
      SET estatus_paciente = $1
      WHERE id_paciente = $2
    `;
    const resPaciente = await client.query(sqlUpdatePaciente, [estatus, idPaciente]);
    
    if (resPaciente.rowCount === 0) {
      await client.query('ROLLBACK');
      return res.status(404).json({ error: "Paciente no encontrado." });
    }

    // 2. LIMPIEZA DE AGENDA (¡LA NUEVA LÓGICA!)
    // Si el estatus es 'Baja' (o como lo llames para salida definitiva), borramos el futuro.
    // Borramos solo las que están 'Agendada' o 'Pendiente' (las que faltan).
    // Respetamos las 'Realizada', 'Cancelada' o 'No asistió' para el historial.
    
    if (estatus === 'Baja' || estatus === 'Alta') {
        const sqlDeleteFuturo = `
          DELETE FROM citas 
          WHERE id_paciente = $1 
            AND (estatus = 'Agendada' OR estatus = 'Pendiente')
        `;
        const resDelete = await client.query(sqlDeleteFuturo, [idPaciente]);
        console.log(`🗑️ Se eliminaron ${resDelete.rowCount} citas futuras/pendientes del paciente.`);
    }

    await client.query('COMMIT'); // Guardamos todo
    console.log("✅ Paciente actualizado y agenda limpia.");
    
    res.json({ 
      message: `Paciente actualizado a: ${estatus}. Se limpió su agenda futura.` 
    });

  } catch (error) {
    await client.query('ROLLBACK');
    console.error("🔥 Error fatal al finalizar paciente:", error);
    res.status(500).json({ error: "Error del servidor" });
  } finally {
    client.release();
  }
});


// --- RUTA: Crear Bloque de Valoración (CORREGIDA FINAL) ---
// -----------------------------------------------------------
// -----------------------------------------------------------
// --- RUTA: Crear Bloque de Valoración (CORREGIDA: Respeta num_programa) ---
// -----------------------------------------------------------
// -----------------------------------------------------------
// --- RUTA: Crear Bloque de Valoración (CORREGIDA: Actualiza Motivo y Servicio) ---
// -----------------------------------------------------------
// -----------------------------------------------------------
// --- RUTA: Crear Bloque de Valoración (FINAL BLINDADA) ---
// -----------------------------------------------------------
// -----------------------------------------------------------
// --- RUTA: Crear Bloque de Valoración (VERSIÓN DEBUGGER) ---
// -----------------------------------------------------------
app.post("/crear-bloque-valoracion", async (req, res) => {
  // 1. CHIVATO: LOGUEAMOS TODO EL BODY CRUDO
  console.log("\n🛑🛑🛑 --- DEBUG DE ENTRADA --- 🛑🛑🛑");
  console.log("Recibido en req.body:", JSON.stringify(req.body, null, 2));

  const { 
    datosPaciente, 
    listaCitas, 
    idPersonal, 
    idPacienteExistente, 
    idCitaOrigen, 
    asistenciaOrigen,
    num_programa // <--- Intentamos sacarlo de aquí
  } = req.body;

  // 2. LÓGICA DE DETECCIÓN DEL NIVEL
  // Prioridad: 1. Lo que viene suelto -> 2. Lo que viene en datosPaciente -> 3. Default 1
  let programaFinal = 1;
  
  if (num_programa) {
      programaFinal = parseInt(num_programa);
      console.log("✅ Usando num_programa 'suelto' del body:", programaFinal);
  } else if (datosPaciente && datosPaciente.num_programa) {
      programaFinal = parseInt(datosPaciente.num_programa);
      console.log("⚠️ Usando num_programa de datosPaciente:", programaFinal);
  } else if (datosPaciente && datosPaciente.num_programa_actual) {
      // Por si acaso Flutter lo manda con el nombre largo
      programaFinal = parseInt(datosPaciente.num_programa_actual);
      console.log("⚠️ Usando num_programa_actual de datosPaciente:", programaFinal);
  } else {
      console.log("❌ NO SE ENCONTRÓ NIVEL. Usando Default: 1");
  }

  console.log("🎯 NIVEL FINAL A GUARDAR:", programaFinal);
  console.log("------------------------------------------\n");

  if (!listaCitas || listaCitas.length === 0 || !idPersonal) {
    return res.status(400).json({ error: "Faltan datos para el bloque" });
  }

  const client = await pool.connect();

  try {
    await client.query("BEGIN"); 

    // 1. CERRAR CITA ORIGEN
    if (idCitaOrigen) {
       const asistenciaFinal = (asistenciaOrigen && asistenciaOrigen > 0) ? asistenciaOrigen : 4;
       await client.query(
         `UPDATE citas SET tipo_cita = 'V', estatus = 'Realizada', asistencia = $1 WHERE id_cita = $2`, 
         [asistenciaFinal, idCitaOrigen]
       );
    }

    let idPacienteFinal;

    if (idPacienteExistente) {
        // --- CASO: UPDATE PACIENTE ---
        idPacienteFinal = idPacienteExistente;
        console.log(`🔄 Actualizando Paciente ID: ${idPacienteFinal} al Nivel ${programaFinal}`);
        
        // 🔥 CORRECCIÓN IMPORTANTE: AGREGAMOS 'num_programa_actual' AL UPDATE
        // Si no actualizas esto, el paciente se queda en el pasado.
        const sqlUpdatePaciente = `
            UPDATE paciente 
            SET 
              motivo_estudio = $1, 
              servicio = $2,        
              domicilio = $3,       
              telefono = $4,
              edad = $5,
              num_programa_actual = $6  -- <--- CAMPO NUEVO IMPORTANTE
            WHERE id_paciente = $7
        `;
        
        const resUpdate = await client.query(sqlUpdatePaciente, [
            datosPaciente.motivo_estudio,
            datosPaciente.servicio,       
            datosPaciente.domicilio,      
            datosPaciente.telefono,       
            datosPaciente.edad,
            programaFinal, // <--- Guardamos el Nivel Nuevo en el Paciente
            idPacienteFinal               
        ]);
        
        if (resUpdate.rowCount === 0) {
            throw new Error(`Paciente ID ${idPacienteFinal} no encontrado.`);
        }

    } else {
        // --- CASO: INSERT PACIENTE ---
        console.log("🆕 Creando paciente nuevo con Nivel", programaFinal);
        
        // También aquí agregamos num_programa_actual
        const sqlInsertPaciente = `
           INSERT INTO paciente (
              nombre, edad, fecha_nac, entidad_fed, curp, domicilio, 
              cp, telefono, sexo, edo_civil, escolaridad, ref_medica, 
              servicio, motivo_estudio, estatus_paciente, num_programa_actual
           )
           VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9, $10, $11, $12, $13, $14, 'Activo', $15)
           RETURNING id_paciente; 
        `;
        const p = datosPaciente;
        const valores = [
            p.nombre, p.edad, p.fecha_nac, p.entidad_fed, p.curp, p.domicilio, 
            p.cp, p.telefono, p.sexo, p.edo_civil, p.escolaridad, p.ref_medica, 
            p.servicio, p.motivo_estudio, 
            programaFinal // <--- $15
        ];
        
        const resPac = await client.query(sqlInsertPaciente, valores);
        idPacienteFinal = resPac.rows[0].id_paciente;
    }

    // 2. INSERTAR CITAS
    const totalVal = listaCitas.length;
    let indice = 1;

    const sqlCita = `
      INSERT INTO citas (
          id_paciente, id_personal, fecha, hora_inicio, hora_fin, 
          servicio_area, estatus, tipo_cita, num_programa, indice_val, total_val
      ) VALUES ($1, $2, $3, $4, $5, $6, 'Agendada', 'P', $9, $7, $8); 
    `;

    const servicioGuardar = datosPaciente.servicio || "General";

    for (const cita of listaCitas) {
      // Usamos programaFinal que ya calculamos arriba
      await client.query(sqlCita, [
        idPacienteFinal, idPersonal, cita.fecha, cita.hora_inicio, cita.hora_fin,
        servicioGuardar, indice, totalVal, programaFinal 
      ]);
      indice++;
    }

    await client.query("COMMIT");
    console.log("✅ ÉXITO TOTAL. Nivel guardado:", programaFinal);
    res.status(201).json({ message: "Bloque creado y paciente actualizado", id_paciente: idPacienteFinal });

  } catch (err) {
    await client.query("ROLLBACK");
    console.error("🔥 Error en backend:", err.message);
    res.status(500).json({ error: "Error interno: " + err.message });
  } finally {
    client.release();
  }
});





// --- RUTA: AGENDA PERSONAL DEL TRATANTE ---
// -----------------------------------------------------------
// --- RUTA: AGENDA PERSONAL DEL TRATANTE (CORREGIDA: Trae p.*) ---
// --- RUTA: AGENDA PERSONAL DEL TRATANTE (CORREGIDA: TRAE TODO EL PACIENTE) ---
// --- RUTA: AGENDA PERSONAL DEL TRATANTE (FINAL BLINDADA) ---
app.get("/mi-agenda", async (req, res) => {
  const { id_personal, fecha } = req.query;

  if (!id_personal || !fecha) return res.status(400).json([]);

  const client = await pool.connect();
  try {
    const sql = `
      SELECT 
        c.id_cita,
        c.id_personal, 
        TO_CHAR(c.hora_inicio, 'HH24:MI') as hora_inicio,
        TO_CHAR(c.hora_fin, 'HH24:MI') as hora_fin,
        c.tipo_cita,
        c.estatus,
        c.asistencia,
        c.num_programa,
        c.indice_val,
        c.total_val,
        
        -- DATOS DEL PACIENTE EXPLÍCITOS (Para que no fallen)
        p.id_paciente,
        p.nombre as paciente_nombre,
        p.servicio,
        p.telefono,
        p.domicilio,
        p.fecha_nac,
        p.edad,
        p.sexo,
        p.curp,
        p.cp,             -- <--- AQUÍ ESTÁ EL FAMOSO CP
        p.entidad_fed,
        p.edo_civil,
        p.escolaridad,
        p.ref_medica,
        p.motivo_estudio

      FROM citas c
      JOIN paciente p ON c.id_paciente = p.id_paciente
      WHERE c.id_personal = $1 
      AND c.fecha = $2
      ORDER BY c.hora_inicio ASC
    `;
    const result = await client.query(sql, [id_personal, fecha]);
    res.json(result.rows);
  } catch (error) {
    console.error("Error en /mi-agenda:", error);
    res.status(500).json([]);
  } finally {
    client.release();
  }
});

// Endpoint: Registrar Sesión (Bitácora) - CORREGIDO (Sin check_out)
app.post('/registrar-sesion', async (req, res) => {
  const { 
    id_cita, 
    id_paciente, 
    observaciones, 
    tipo_terapia, 
    estatus_asistencia,
    monto_pago,    
    tipo_paciente  
  } = req.body;

  if (!id_cita || !id_paciente || !estatus_asistencia) {
    return res.status(400).json({ error: "Faltan datos obligatorios" });
  }

  try {
    await pool.query('BEGIN');

    // 1. ACTUALIZAR TIPO DE PACIENTE
    if (tipo_paciente) {
      const queryPaciente = `UPDATE paciente SET tipo_paciente = $1 WHERE id_paciente = $2`;
      await pool.query(queryPaciente, [tipo_paciente, id_paciente]);
    }

    // 2. INSERTAR EN HISTORIAL
    const queryHistorial = `
      INSERT INTO historial_consultas 
      (id_cita, id_paciente, observaciones, tipo_terapia, fecha_vencimiento)
      VALUES ($1, $2, $3, $4, NULL) 
    `;
    await pool.query(queryHistorial, [id_cita, id_paciente, observaciones, tipo_terapia]);

    // 3. ACTUALIZAR CITA
    const pagoFinal = monto_pago || 0;

    const queryUpdateCita = `
      UPDATE citas 
      SET 
        asistencia = $1,     
        estatus = 'Finalizada',
        pago = $2,           -- 💰 Guardamos el dinero
        
        -- Quitamos check_out porque no tienes la columna
        
        tipo_cita = CASE WHEN tipo_cita = 'P' THEN 'V' ELSE tipo_cita END
        
      WHERE id_cita = $3
    `;

    await pool.query(queryUpdateCita, [estatus_asistencia, pagoFinal, id_cita]);

    await pool.query('COMMIT');
    res.status(200).json({ message: "Sesión y pago registrados correctamente" });

  } catch (err) {
    await pool.query('ROLLBACK');
    console.error("Error SQL:", err.message);
    res.status(500).json({ error: "Error de base de datos: " + err.message });
  }
});

// Endpoint: Crear Programa Asignado (Futuro)
// Endpoint: Crear Programa Asignado (Futuro) - CORREGIDO ÍNDICES
// Endpoint: Crear Programa Asignado (CORREGIDO NUM PROGRAMA Y SERVICIO)
// Endpoint: Crear Programa Asignado (CORREGIDO: Lógica 1 de 1 para 'A')
// Endpoint: Crear Programa Asignado (FINAL: Respeta 'A' y corrige conteos)
// Endpoint: Crear Programa Asignado
// Descripción: Crea citas nuevas, cierra la anterior y actualiza el área del paciente si aplica.
app.post('/crear-programa-asignado', async (req, res) => {
  const { 
    id_paciente, 
    id_personal, 
    id_cita_origen, 
    asistencia_origen, 
    tipo_cita, 
    nuevas_citas, 
    servicio_area,
    num_programa // <--- 1. AGREGADO AQUÍ PARA RECIBIRLO
  } = req.body;

  try {
    await pool.query('BEGIN');

    // ---------------------------------------------------------
    // 1. ACTUALIZAR CITA ORIGEN (Si existe)
    // ---------------------------------------------------------
    if (id_cita_origen) {
      const updateOrigenQuery = `
        UPDATE citas 
        SET 
          asistencia = $1, 
          estatus = 'Finalizada', 
          tipo_cita = CASE 
                        WHEN tipo_cita = 'P' THEN 'V' 
                        ELSE tipo_cita                
                      END
        WHERE id_cita = $2
      `;
      await pool.query(updateOrigenQuery, [asistencia_origen, id_cita_origen]);
    }

    // ---------------------------------------------------------
    // 2. LÓGICA DE SERVICIO Y ÁREA
    // ---------------------------------------------------------
    
    // 👇👇👇 2. CAMBIO IMPORTANTE EN LA LÓGICA DE NIVEL 👇👇👇
    // Si Flutter mandó el nivel (ej. 2), lo usamos. Si no, asumimos null por ahora.
    let numProgramaBase = num_programa ? parseInt(num_programa) : null;
    
    let servicioOriginal = 'General';

    // Recuperar datos de la cita origen (para servicio y fallback de nivel)
    if (id_cita_origen) {
      const origenRes = await pool.query(
        'SELECT num_programa, servicio_area FROM citas WHERE id_cita = $1', 
        [id_cita_origen]
      );
      if (origenRes.rows.length > 0) {
        // Solo si NO recibimos nivel desde Flutter, usamos el de la BD
        if (!numProgramaBase) {
             numProgramaBase = origenRes.rows[0].num_programa || 1;
        }
        servicioOriginal = origenRes.rows[0].servicio_area || 'General';
      }
    }

    // Si después de todo sigue nulo, el default es 1
    if (!numProgramaBase) numProgramaBase = 1;

    console.log("🎯 Nivel final a guardar:", numProgramaBase); // Log para confirmar

    // Prioridad de Asignación de Servicio
    let servicioFinal = servicio_area || servicioOriginal;

    if (!servicioFinal || servicioFinal === 'null') {
       const personalRes = await pool.query(
         'SELECT funcion FROM personal WHERE id_personal = $1', 
         [id_personal]
       );
       servicioFinal = personalRes.rows.length > 0 ? personalRes.rows[0].funcion : 'General';
    }

    // ---------------------------------------------------------
    // 3. ACTUALIZAR PERFIL DEL PACIENTE
    // ---------------------------------------------------------
    if (servicioFinal && servicioFinal !== 'General') {
       // 🔥 OJO: Aquí también actualizamos el num_programa_actual del paciente
       // para que quede sincronizado en su ficha.
       await pool.query(
         "UPDATE paciente SET servicio = $1, num_programa_actual = $2 WHERE id_paciente = $3",
         [servicioFinal, numProgramaBase, id_paciente]
       );
    } else {
        // Si el servicio no cambia, al menos actualizamos el nivel
        await pool.query(
            "UPDATE paciente SET num_programa_actual = $1 WHERE id_paciente = $2",
            [numProgramaBase, id_paciente]
        );
    }

    // ---------------------------------------------------------
    // 4. INSERTAR LAS NUEVAS CITAS
    // ---------------------------------------------------------
    const insertQuery = `
      INSERT INTO citas 
      (id_paciente, id_personal, fecha, hora_inicio, hora_fin, tipo_cita, estatus, asistencia, servicio_area, num_programa, indice_val, total_val)
      VALUES ($1, $2, $3, $4, $5, $6, 'Pendiente', 0, $7, $8, $9, $10)
    `;

    for (let i = 0; i < nuevas_citas.length; i++) {
      const cita = nuevas_citas[i];
      
      const isTratamiento = (tipo_cita !== 'P');
      const indiceParaGuardar = isTratamiento ? 1 : (i + 1);
      const totalParaGuardar  = isTratamiento ? 1 : nuevas_citas.length;

      await pool.query(insertQuery, [
        id_paciente,
        id_personal,
        cita.fecha,
        cita.hora_inicio,
        cita.hora_fin,
        tipo_cita, 
        servicioFinal, 
        numProgramaBase, // <--- Aquí ya lleva el valor correcto (2, 3, etc.)
        indiceParaGuardar, 
        totalParaGuardar
      ]);
    }

    await pool.query('COMMIT');
    
    res.status(201).json({ 
      message: "Programa creado y paciente actualizado correctamente." 
    });

  } catch (err) {
    await pool.query('ROLLBACK');
    console.error("Error en crear-programa-asignado:", err);
    res.status(500).json({ error: "Error interno: " + err.message });
  }
});

// -----------------------------------------------------------
// --- RUTA: PACIENTES BAJA/ALTA (+ HISTORIAL DETALLADO) ---
// -----------------------------------------------------------
app.get("/pacientes-bajas-altas", async (req, res) => {
  const { tipo } = req.query; // 'BAJA' o 'ALTA'
  const client = await pool.connect();

  try {
    let filtroEstatus = "";
    if (tipo === 'BAJA') {
      filtroEstatus = "p.estatus_paciente = 'Baja'";
    } else {
      filtroEstatus = "p.estatus_paciente IN ('Alta', 'Finalizado')";
    }

    const sql = `
      SELECT 
        p.*,
        -- Datos del tutor
        f.nombre as nombre_tutor,
        f.telefono as telefono_tutor,
        
        -- Datos de la CITA (Todas las columnas importantes)
        c.id_cita, 
        c.fecha, 
        c.hora_inicio, 
        c.asistencia, 
        c.servicio_area,
        c.tipo_cita,      -- 'P' (Primera vez), 'A' (Tratamiento/Asignado)
        c.num_programa,   -- Nivel o Bloque (1, 2, 3...)
        c.pago,           -- Dinero registrado
        
        per.nombre as nombre_tratante,
        hc.observaciones
        
      FROM paciente p
      LEFT JOIN familiar f ON p.id_paciente = f.id_paciente
      LEFT JOIN citas c ON p.id_paciente = c.id_paciente
      LEFT JOIN personal per ON c.id_personal = per.id_personal
      LEFT JOIN historial_consultas hc ON c.id_cita = hc.id_cita
      
      WHERE ${filtroEstatus}
      
      ORDER BY p.nombre ASC, c.fecha DESC
    `;

    const result = await client.query(sql);

    const pacientesMap = {};

    result.rows.forEach(row => {
      // 1. Crear paciente si no existe
      if (!pacientesMap[row.id_paciente]) {
        pacientesMap[row.id_paciente] = {
          id_paciente: row.id_paciente,
          nombre: row.nombre,
          servicio: row.servicio,
          telefono: row.telefono,
          estatus_paciente: row.estatus_paciente,
          edad: row.edad || 'N/D',
          direccion: row.direccion || '',
          nombre_tutor: row.nombre_tutor || '',
          telefono_tutor: row.telefono_tutor || '',
          historial: [] 
        };
      }

      // 2. Agregar cita al historial (Si existe id_cita)
      if (row.id_cita) {
        pacientesMap[row.id_paciente].historial.push({
          id_cita: row.id_cita,
          fecha: row.fecha, // Se enviará como ISO string
          hora: row.hora_inicio,
          asistencia: row.asistencia || 0, // Si es null, enviamos 0
          tratante: row.nombre_tratante,
          observacion: row.observaciones || '',
          servicio_area: row.servicio_area,
          
          // 🔥 DATOS NUEVOS AGREGADOS 🔥
          tipo_cita: row.tipo_cita || 'N/A',
          num_programa: row.num_programa || 1, // Nivel
          pago: row.pago ? parseFloat(row.pago) : 0.0 // Aseguramos formato moneda
        });
      }
    });

    // 3. Convertir Map a Array y calcular resumen rápido
    const listaFinal = Object.values(pacientesMap).map(p => {
        // Contamos faltas (1, 2, 3 son tipos de inasistencia)
        p.cant_faltas = p.historial.filter(c => [1,2,3].includes(c.asistencia)).length;
        // Fecha más reciente (la primera porque ordenamos DESC en SQL)
        p.fecha_ultimo_evento = p.historial.length > 0 ? p.historial[0].fecha : null;
        return p;
    });

    res.json(listaFinal);

  } catch (error) {
    console.error("🔥 Error en /pacientes-bajas-altas:", error);
    res.status(500).json({ error: "Error al obtener reporte" });
  } finally {
    client.release();
  }
});


// -----------------------------------------------------------
// --- RUTA: FINALIZAR VALORACIÓN ANTICIPADAMENTE (Corte de Caja) ---
// -----------------------------------------------------------
app.post('/finalizar-valoracion-anticipada', async (req, res) => {
  const { id_cita_actual, id_paciente, num_programa, observaciones, asistencia } = req.body;

  try {
    await pool.query('BEGIN');

    // 1. Guardar la sesión actual como FINALIZADA y tipo 'V' (Para que cuente como la última)
    // También guardamos en historial
    await pool.query(`
      INSERT INTO historial_consultas (id_cita, id_paciente, observaciones, tipo_terapia)
      VALUES ($1, $2, $3, 'Valoración (Cierre Anticipado)')`, 
      [id_cita_actual, id_paciente, observaciones]
    );

    await pool.query(`
      UPDATE citas 
      SET estatus = 'Realizada', asistencia = $1, tipo_cita = 'V'
      WHERE id_cita = $2`,
      [asistencia, id_cita_actual]
    );

    // 2. BORRAR EL FUTURO
    // Eliminamos todas las citas 'P' que sean de este mismo paciente, mismo programa,
    // que estén Agendadas/Pendientes y que NO sean la cita actual.
    const deleteQuery = `
      DELETE FROM citas 
      WHERE id_paciente = $1 
        AND num_programa = $2 
        AND tipo_cita = 'P' 
        AND (estatus = 'Agendada' OR estatus = 'Pendiente')
        AND id_cita != $3
    `;
    
    const resDelete = await pool.query(deleteQuery, [id_paciente, num_programa, id_cita_actual]);
    console.log(`🗑️ Se eliminaron ${resDelete.rowCount} citas futuras sobrantes.`);

    await pool.query('COMMIT');
    res.json({ message: "Valoración finalizada anticipadamente." });

  } catch (err) {
    await pool.query('ROLLBACK');
    console.error("Error al finalizar anticipadamente:", err);
    res.status(500).json({ error: "Error interno" });
  }
});


// -----------------------------------------------------------
// --- RUTA: CREAR REFERENCIA (INTERCONSULTA) ---
// -----------------------------------------------------------
app.post('/crear-referencia', async (req, res) => {
  const { id_paciente, id_personal_destino, fecha, hora, area_destino, motivo } = req.body;

  if (!id_paciente || !id_personal_destino || !fecha || !hora) {
    return res.status(400).json({ error: "Faltan datos para la referencia" });
  }

  const client = await pool.connect();
  try {
    await client.query('BEGIN');

    // 1. Averiguar el siguiente número de programa (Nueva vuelta)
    // Si ya iba en el programa 1, esta referencia inicia el programa 2
    const resNum = await client.query(
      'SELECT COALESCE(MAX(num_programa), 0) + 1 as nuevo_num FROM citas WHERE id_paciente = $1',
      [id_paciente]
    );
    const nuevoNumPrograma = resNum.rows[0].nuevo_num;

    // 2. Insertar la nueva cita 'P'
    const sqlInsert = `
      INSERT INTO citas (
        id_paciente, id_personal, fecha, hora_inicio, hora_fin, 
        servicio_area, estatus, tipo_cita, 
        num_programa, indice_val, total_val
      )
      VALUES ($1, $2, $3, $4, $4::time + interval '1 hour', $5, 'Agendada', 'P', $6, 1, 1)
      RETURNING id_cita;
    `;

    const resCita = await client.query(sqlInsert, [
      id_paciente, 
      id_personal_destino, 
      fecha, 
      hora, 
      area_destino,
      nuevoNumPrograma // Iniciamos un nuevo ciclo
    ]);

    // 3. (Opcional) Guardar el motivo en el historial para que el nuevo doctor sepa por qué se lo mandaron
    const idNuevaCita = resCita.rows[0].id_cita;
    if (motivo) {
      await client.query(`
        INSERT INTO historial_consultas (id_cita, id_paciente, observaciones, tipo_terapia)
        VALUES ($1, $2, $3, 'Referencia / Interconsulta')
      `, [idNuevaCita, id_paciente, `PACIENTE REFERIDO: ${motivo}`]);
    }

    await client.query('COMMIT');
    res.status(200).json({ message: "Referencia creada exitosamente" });

  } catch (error) {
    await client.query('ROLLBACK');
    console.error("🔥 Error en /crear-referencia:", error);
    res.status(500).json({ error: "Error al crear referencia" });
  } finally {
    client.release();
  }
});


//////////////////////////////CAMPO TALI/////////////////TALIMON//////////////TALIMON/////////////////////////////////////////
// -----------------------------------------------------------
// --- NUEVA RUTA: GUARDAR ESTUDIO SOCIAL COMPLETO ---
// -----------------------------------------------------------
app.post("/guardar-estudio-social", async (req, res) => {
  const { idPaciente, familiares, datosPaciente } = req.body;

  console.log("\n--- 📝 GUARDANDO ESTUDIO SOCIAL ---");
  console.log("ID Paciente:", idPaciente);
  // console.log("Datos recibidos:", datosPaciente);

  if (!idPaciente || !datosPaciente) {
    return res.status(400).json({ error: "Faltan datos del paciente o ID." });
  }

  const client = await pool.connect();
  try {
    await client.query("BEGIN"); // Iniciamos transacción

    // 1. ACTUALIZAR PACIENTE
    const sqlUpdatePaciente = `
      UPDATE paciente SET
        no_expediente = $1,
        clasificacion = $2,
        fecha_estudios = $3,
        ocupacion = $4,
        tel_trabajo = $5,
        tel_domicilio = $6,        
        num_consultorio = $7,
        nombre_entrevistado = $8,
        parentesco = $9,           
        
        ingreso_p = $10,
        ingreso_m = $11,
        ingreso_h = $12,
        ingreso_u = $13,
        ingreso_o = $14,
        total_ingreso = $15,
        
        egreso_alim = $16,
        egreso_renta = $17,
        egreso_servicios = $18,
        egreso_atencionm = $19,
        egreso_educ = $20,
        egreso_trans = $21,
        egreso_recreacion = $22, 
        egreso_vest = $23,
        egreso_otros = $24,
        total_egresos = $25,
        
        deficit_excedente = $26,

        datos_signif = $27,
        diagnostico = $28::text, 
        nombre_ts = $29,
        no_credencial = $30

      WHERE id_paciente = $31
    `;

    const valuesPaciente = [
      datosPaciente.no_expediente,
      datosPaciente.clasificacion,
      datosPaciente.fecha_estudios,
      datosPaciente.ocupacion,
      datosPaciente.tel_trabajo,
      datosPaciente.tel_domicilio,
      datosPaciente.num_consultorio,
      datosPaciente.nombre_entrevistado,
      datosPaciente.parentesco_entrevistado,
      
      datosPaciente.ingreso_p || 0,
      datosPaciente.ingreso_m || 0,
      datosPaciente.ingreso_h || 0,
      datosPaciente.ingreso_u || 0,
      datosPaciente.ingreso_o || 0,
      datosPaciente.total_ingreso || 0,

      datosPaciente.egreso_alim || 0,
      datosPaciente.egreso_renta || 0,
      datosPaciente.egreso_servicios || 0,
      datosPaciente.egreso_atencionm || 0,
      datosPaciente.egreso_educ || 0,
      datosPaciente.egreso_trans || 0,
      datosPaciente.egreso_recreacion || 0, 
      datosPaciente.egreso_vest || 0,
      datosPaciente.egreso_otros || 0,
      datosPaciente.total_egresos || 0,

      datosPaciente.deficit_excedente || 0,

      datosPaciente.datos_significativos,
      datosPaciente.diagnostico_plan,
      datosPaciente.nombre_ts,
      datosPaciente.no_credencial,

      idPaciente 
    ];

    await client.query(sqlUpdatePaciente, valuesPaciente);
    console.log("✅ Paciente actualizado.");

    // 2. GUARDAR CARACTERÍSTICAS DE VIVIENDA
    await client.query("DELETE FROM caracteristicas_vivienda WHERE id_paciente = $1", [idPaciente]);

    const sqlVivienda = `
      INSERT INTO caracteristicas_vivienda (
        id_paciente, tipo_vivienda, 
        tiene_sala, tiene_comedor, tiene_cocina, num_banos, num_recamaras,
        servicio_agua, servicio_luz, servicio_drenaje, servicio_alumbrado, servicio_alcantarillado,
        servicio_pavimento, servicio_telefono, servicio_transporte, servicio_limpieza,
        tenencia_propia, tenencia_renta, tenencia_prestada, tenencia_hipoteca, tenencia_int_social, tenencia_paracaidista,
        constr_tabique_ladrillo, constr_carton, constr_lamina, constr_otro,
        barrera_int_escaleras, barrera_int_espacio_reducido, barrera_int_falta_adecuacion, barrera_int_falta_mobiliario,
        barrera_ext_calle_inaccesible, barrera_ext_sin_pavimento, barrera_ext_pendientes, barrera_ext_barrancas
      ) VALUES (
        $1, $2, 
        $3, $4, $5, $6, $7,
        $8, $9, $10, $11, $12,
        $13, $14, $15, $16,
        $17, $18, $19, $20, $21, $22,
        $23, $24, $25, $26,
        $27, $28, $29, $30,
        $31, $32, $33, $34
      )
    `;

    const valuesVivienda = [
        idPaciente, datosPaciente.tipo_vivienda,
        datosPaciente.tiene_sala, datosPaciente.tiene_comedor, datosPaciente.tiene_cocina, datosPaciente.num_banos, datosPaciente.num_recamaras,
        datosPaciente.servicio_agua, datosPaciente.servicio_luz, datosPaciente.servicio_drenaje, datosPaciente.servicio_alumbrado, datosPaciente.servicio_alcantarillado,
        datosPaciente.servicio_pavimento, datosPaciente.servicio_telefono, datosPaciente.servicio_transporte, datosPaciente.servicio_limpieza,
        datosPaciente.tenencia_propia, datosPaciente.tenencia_renta, datosPaciente.tenencia_prestada, datosPaciente.tenencia_hipoteca, datosPaciente.tenencia_int_social, datosPaciente.tenencia_paracaidista,
        datosPaciente.constr_tabique_ladrillo, datosPaciente.constr_carton, datosPaciente.constr_lamina, datosPaciente.constr_otro,
        datosPaciente.barrera_int_escaleras, datosPaciente.barrera_int_espacio_reducido, datosPaciente.barrera_int_falta_adecuacion, datosPaciente.barrera_int_falta_mobiliario,
        datosPaciente.barrera_ext_calle_inaccesible, datosPaciente.barrera_ext_sin_pavimento, datosPaciente.barrera_ext_pendientes, datosPaciente.barrera_ext_barrancas
    ];

    await client.query(sqlVivienda, valuesVivienda);
    console.log("✅ Vivienda guardada.");

    // 3. GUARDAR FAMILIARES (CORREGIDO: TABLA 'familiar')
    await client.query("DELETE FROM familiar WHERE id_paciente = $1", [idPaciente]);

    const sqlFamiliar = `
      INSERT INTO familiar (id_paciente, nombre, parentesco, edad, edo_civil, ocupacion, escolaridad)
      VALUES ($1, $2, $3, $4, $5, $6, $7)
    `;

    // OJO: La variable que recibe el servidor es 'familiares' (así lo envía Flutter)
    // pero insertamos en la tabla 'familiar' (singular).
    if (familiares && familiares.length > 0) {
      for (const fam of familiares) {
        await client.query(sqlFamiliar, [
          idPaciente,
          fam.nombre,
          fam.parentesco,
          fam.edad || 0,
          fam.edoCivil,
          fam.ocupacion,
          fam.escolaridad
        ]);
      }
    }
    console.log(`✅ ${familiares ? familiares.length : 0} familiares guardados.`);

    // 4. ACTUALIZAR CITA P -> V
    const sqlUpdateCita = `
      UPDATE citas 
      SET tipo_cita = 'V', estatus = 'Realizada'
      WHERE id_paciente = $1 
      AND fecha = CURRENT_DATE
    `;
    // Ejecutamos la consulta
    const resultCita = await client.query(sqlUpdateCita, [idPaciente]);
    
    // Esto te dirá en la consola del servidor si funcionó (debe decir 1)
    console.log(`✅ Citas actualizadas en BD: ${resultCita.rowCount}`);
    await client.query(sqlUpdateCita, [idPaciente]);
    console.log("✅ Cita actualizada de P -> V.");

    await client.query("COMMIT"); 
    res.status(200).json({ message: "Estudio Social guardado correctamente." });

  } catch (err) {
    await client.query("ROLLBACK");
    console.error("🔥 Error guardando estudio social:", err);
    res.status(500).json({ error: "Error al guardar el estudio social: " + err.message });
  } finally {
    client.release();
  }
});


// -----------------------------------------------------------
// 🔍 PACIENTES SIN ENTREVISTA (LISTA GLOBAL POR FECHA REGISTRO)
// -----------------------------------------------------------
app.get("/pacientes-pendientes-entrevista", async (req, res) => {
  const { area } = req.query; 

  // YA NO validamos si viene fecha, porque queremos ver todo el historial pendiente.

  const client = await pool.connect();
  try {
    console.log(`\n--- 🕵️‍♂️ BUSCANDO PENDIENTES DE ENTREVISTA (GLOBAL) --- Area: ${area || 'Todas'}`);

    const queryParams = [];
    let filtroAreaSQL = "";

    // Filtro de Área (Opcional) aplicándolo al servicio del PACIENTE
    if (area && area !== "Todas" && area !== "") {
      filtroAreaSQL = "AND p.servicio ILIKE $1"; 
      queryParams.push(`%${area}%`); // Usamos ILIKE con % para ser flexibles
    }

    const sqlPacientes = `
      SELECT DISTINCT ON (p.id_paciente)
        p.id_paciente,
        p.nombre,
        p.edad,
        p.telefono,
        p.tel_domicilio,
        p.domicilio,
        p.entidad_fed,
        p.cp,
        p.sexo,
        p.edo_civil,
        p.escolaridad,
        p.ocupacion,
        p.motivo_estudio,
        p.servicio,           -- Área a la que pertenece
        p.num_consultorio,
        p.fecha_nac,
        
        -- FECHAS IMPORTANTES
        TO_CHAR(p.fecha_registro, 'DD/MM/YYYY') as fecha_registro_fmt,
        p.fecha_registro, -- Para ordenar en el backend si hiciera falta

        -- INFORMACIÓN DE LA PRÓXIMA CITA (Si existe)
        c.id_cita,
        TO_CHAR(c.fecha, 'DD/MM/YYYY') as fecha_proxima_cita,
        TO_CHAR(c.hora_inicio, 'HH24:MI') as hora_inicio_cita,
        TO_CHAR(c.hora_fin, 'HH24:MI') as hora_fin_cita,
        pe.nombre as nombre_terapeuta

      FROM paciente p
      
      -- Unimos con citas SOLO para ver si tiene algo a futuro (Join informativo)
      LEFT JOIN citas c ON p.id_paciente = c.id_paciente 
          AND c.fecha >= CURRENT_DATE 
          AND c.estatus = 'Agendada'
      LEFT JOIN personal pe ON c.id_personal = pe.id_personal

      WHERE p.fecha_estudios IS NULL  -- 👈 LA CONDICIÓN MAESTRA
      AND p.estatus_paciente = 'Activo'
      
      ${filtroAreaSQL}

      -- Ordenamos primero por paciente, y luego para que el DISTINCT tome la cita más cercana
      ORDER BY p.id_paciente, c.fecha ASC
    `;

    const result = await client.query(sqlPacientes, queryParams);
    
    // Opcional: Ordenamos la lista final por fecha de registro (el más viejo primero)
    // Lo hacemos en JS o en SQL, aquí aseguramos que salga ordenado por antigüedad.
    const listaOrdenada = result.rows.sort((a, b) => {
        return new Date(a.fecha_registro) - new Date(b.fecha_registro);
    });

    res.json(listaOrdenada);

  } catch (error) {
    console.error("🔥 Error en /pacientes-pendientes-entrevista:", error);
    res.status(500).json({ error: "Error al buscar pendientes" });
  } finally {
    client.release();
  }
});

// 📅 OBTENER CITAS DE HOY (Para Trabajo Social / Dashboard)
// -----------------------------------------------------------
// 📅 REGISTROS DE HOY (SALA DE ESPERA + CITAS)
// -----------------------------------------------------------
app.get("/citas-hoy", async (req, res) => {
  try {
    const client = await pool.connect();
    
    // Obtenemos fecha de hoy para filtrar registros nuevos
    const hoy = new Date().toISOString().split('T')[0];
    
    console.log(`\n--- 🕵️‍♂️ BUSCANDO REGISTROS DE HOY (${hoy}) ---`);

    const query = `
      SELECT 
        p.id_paciente, 
        p.nombre, 
        p.fecha_registro,
        p.fecha_estudios, -- 👇 CLAVE: Para saber si ya lo entrevistaste

        -- MANTENEMOS TUS CAMPOS ORIGINALES (Pero ahora pueden ser NULL si no hay cita)
        c.hora_inicio, 
        c.hora_fin, 
        c.estatus, 
        c.tipo_cita as "tipoCita", -- 👈 Tu campo importante preservado

        -- LÓGICA DE ESTATUS PARA EL BOTÓN (Calculada en SQL)
        CASE 
            WHEN p.fecha_estudios IS NOT NULL THEN 'REALIZADA' 
            ELSE 'PENDIENTE' 
        END as estatus_entrevista

      FROM paciente p
      
      -- USAMOS LEFT JOIN:
      -- Esto significa: "Trae al paciente SIEMPRE. Si tiene cita hoy, pega los datos. Si no, déjalos en NULL".
      LEFT JOIN citas c ON p.id_paciente = c.id_paciente AND c.fecha = $1
      
      -- FILTRO MAESTRO:
      -- Buscamos a todos los que se REGISTRARON hoy en recepción
      WHERE p.fecha_registro = $1
      AND p.estatus_paciente = 'Activo'
      
      -- Ordenamos: Los más recientes arriba
      ORDER BY p.id_paciente DESC;
    `;
    
    // Usamos parámetros ($1) para evitar problemas de zona horaria con CURRENT_DATE
    const result = await client.query(query, [hoy]);
    client.release();

    res.json(result.rows);

  } catch (err) {
    console.error("Error al obtener registros de hoy:", err);
    res.status(500).json({ error: "Error interno" });
  }
});


//////////////////////////////CAMPO TALI/////////////////TALIMON//////////////TALIMON/////////////////////////////////////////

// --- NUEVO ENDPOINT: CARGA DE TRABAJO POR TERAPEUTA (CORREGIDO) ---
app.get('/estadisticas-carga', async (req, res) => {
  try {
const query = `
      SELECT 
        p.id_personal,
        p.nombre,
        
        -- 👇 AQUÍ ESTÁ LA MAGIA DE LA UNIFICACIÓN 👇
        CASE 
            WHEN p.funcion IN ('Psicologia', 'Psicología') THEN 'Psicología'
            WHEN p.funcion IN ('Médico', 'Medico') THEN 'Médico'
            WHEN p.funcion IN ('Terapeuta Fisico', 'Terapeuta Físico') THEN 'Terapeuta Físico'
            ELSE p.funcion 
        END as area, 
        -- 👆 Esto convierte todo al nombre bonito con acento 👆

        EXTRACT(MONTH FROM c.fecha) as mes_num,
        TO_CHAR(c.fecha, 'Month') as mes_nombre,
        EXTRACT(WEEK FROM c.fecha) as semana_num,
        MIN(c.fecha) as inicio_semana, 
        MAX(c.fecha) as fin_semana,    
        c.tipo_cita,
        COUNT(*) as total
      FROM personal p
      LEFT JOIN citas c ON p.id_personal = c.id_personal AND c.fecha >= DATE_TRUNC('year', CURRENT_DATE) 
      
      -- Mantenemos el filtro amplio para encontrar a todos (feos y bonitos)
      WHERE p.funcion IN (
          'Psicologia', 'Psicología', 
          'Terapeuta Autismo', 
          'Terapeuta Lenguaje', 
          'Terapeuta Fisico', 'Terapeuta Físico',
          'Médico', 'Medico'
      )
      
      GROUP BY p.id_personal, p.nombre, p.funcion, mes_num, mes_nombre, semana_num, c.tipo_cita
      ORDER BY area, p.nombre, mes_num, semana_num; -- Ordenamos por el área unificada
    `;
    
    const result = await pool.query(query);
    
    const cargaTrabajo = {};

    result.rows.forEach(row => {
      const id = row.id_personal;
      
      // 1. Siempre creamos al terapeuta (tenga citas o no)
      if (!cargaTrabajo[id]) {
        cargaTrabajo[id] = {
          id: id,
          nombre: row.nombre, 
          area: row.area,     
          meses: {}
        };
      }

      // 🚨 FIX: Si no hay mes (es null), es un terapeuta sin trabajo.
      // Nos salimos de este ciclo aquí para no tronar con el .trim()
      if (!row.mes_num) return; 

      // --- A partir de aquí solo entra si TIENE citas ---
      const mesKey = row.mes_num; 

      if (!cargaTrabajo[id].meses[mesKey]) {
        cargaTrabajo[id].meses[mesKey] = {
          // Usamos el ? por seguridad extra
          nombre: row.mes_nombre ? row.mes_nombre.trim() : 'Mes Desconocido',
          primera_vez: 0,
          tratamiento: 0,
          semanas: {}
        };
      }

      const cantidad = parseInt(row.total);
      if (row.tipo_cita === 'P' || row.tipo_cita === 'V') {
        cargaTrabajo[id].meses[mesKey].primera_vez += cantidad;
      } else if (row.tipo_cita === 'A') {
        cargaTrabajo[id].meses[mesKey].tratamiento += cantidad;
      }

      const semKey = row.semana_num;
      if (!cargaTrabajo[id].meses[mesKey].semanas[semKey]) {
        cargaTrabajo[id].meses[mesKey].semanas[semKey] = {
          rango: `Del ${new Date(row.inicio_semana).getDate()} al ${new Date(row.fin_semana).getDate()}`,
          primera_vez: 0,
          tratamiento: 0
        };
      }

      if (row.tipo_cita === 'P' || row.tipo_cita === 'V') {
        cargaTrabajo[id].meses[mesKey].semanas[semKey].primera_vez += cantidad;
      } else if (row.tipo_cita === 'A') {
        cargaTrabajo[id].meses[mesKey].semanas[semKey].tratamiento += cantidad;
      }
    });

    const respuestaFinal = Object.values(cargaTrabajo).map(t => {
      t.meses = Object.values(t.meses).map(m => {
        m.semanas = Object.values(m.semanas);
        return m;
      });
      return t;
    });

    res.json(respuestaFinal);

  } catch (error) {
    console.error(error);
    res.status(500).json({ error: "Error calculando carga de trabajo" });
  }
});

// -----------------------------------------------------------
// --- RUTA: SALA DE ESPERA (FIX DEFINITIVO NIVEL) ---
// -----------------------------------------------------------
app.get("/pacientes/pendientes-cita", async (req, res) => {
  try {
    const query = `
      SELECT p.* FROM paciente p
      WHERE 
      p.estatus_paciente = 'Activo'
      
      AND NOT EXISTS (
        SELECT 1 
        FROM citas c 
        WHERE c.id_paciente = p.id_paciente 
        
        AND UPPER(c.estatus) NOT IN ('CANCELADA', 'BAJA') 

        -- 👇👇👇 AQUÍ ESTÁ EL CAMBIO MAESTRO 👇👇👇
        -- Antes tenías un OR separado. Ahora obligamos a que TODO coincida con el nivel.
        
        AND c.num_programa = p.num_programa_actual -- 1. Solo miramos citas del Nivel 2

        AND (
             -- 2. Y dentro de ese nivel, buscamos si ya tiene algo agendado o hecho.
             c.fecha >= CURRENT_DATE 
             OR
             c.estatus = 'Finalizada' -- O si ya empezó tratamiento
        )
      )
      ORDER BY p.fecha_registro ASC;
    `;
    
    const result = await pool.query(query);
    res.json(result.rows);

  } catch (err) {
    console.error("Error en pendientes:", err);
    res.status(500).json({ error: "Error interno" });
  }
});
// 🚀 NUEVO SERVICIO: Guardar paciente (Corregido y Alineado)
// -----------------------------------------------------------
// --- RUTA MAESTRA: GUARDAR PACIENTE + GENERAR CITA (NUEVO O REAGENDADO) ---
// -----------------------------------------------------------
// -----------------------------------------------------------
// --- RUTA MAESTRA: GUARDAR PACIENTE + GENERAR CITA ---
// -----------------------------------------------------------
// 🚀 NUEVO SERVICIO: Guardar paciente (Corregido y Alineado)
app.post("/pacientes", async (req, res) => {
  // 1. Recibimos el dato nuevo del body
  const { 
    nombre, edad, fecha_nac, entidad_fed, curp, domicilio, 
    cp, telefono, sexo, edo_civil, escolaridad, ref_medica, 
    servicio, motivo_estudio, 
    num_programa,               // Este lo usaremos para 'num_programa_actual'
    es_estimulacion_temprana    // 👈 NUEVO CAMPO
  } = req.body;

  try {
    const query = `
      INSERT INTO paciente (
        nombre, 
        edad, 
        fecha_nac, 
        entidad_fed, 
        curp, 
        domicilio, 
        cp, 
        telefono, 
        sexo, 
        edo_civil, 
        escolaridad, 
        ref_medica, 
        servicio, 
        motivo_estudio, 
        fecha_registro,            -- Columna 15
        es_estimulacion_temprana,  -- Columna 16
        num_programa_actual        -- Columna 17
      ) VALUES (
        $1, $2, $3, $4, $5, $6, 
        $7, $8, $9, $10, $11, $12, 
        $13, $14, 
        NOW(), -- Valor para fecha_registro (automático)
        $15,   -- Valor para es_estimulacion_temprana
        $16    -- Valor para num_programa_actual
      ) 
      RETURNING id_paciente;
    `;
    
    const values = [
      nombre, 
      edad, 
      fecha_nac, 
      entidad_fed, 
      curp, 
      domicilio, 
      cp, 
      telefono, 
      sexo, 
      edo_civil, 
      escolaridad, 
      ref_medica, 
      servicio, 
      motivo_estudio,               // Hasta aquí van $14
      es_estimulacion_temprana || false, // $15 (Booleano)
      num_programa || 1             // $16 (Entero)
    ];

    const result = await pool.query(query, values);
    res.status(201).json(result.rows[0]);

  } catch (err) {
    console.error("Error en POST /pacientes:", err); // Agregué mensaje para identificarlo rápido en logs
    res.status(500).send("Error al registrar paciente");
  }
});

// -----------------------------------------------------------
// --- RUTA PARA ACTUALIZAR PACIENTE (PUT) ---
// -----------------------------------------------------------
app.put("/pacientes", async (req, res) => {
  // 1. Recibimos el ID y los datos a actualizar
  const { 
    id_paciente, // ¡CRUCIAL! Sin esto no sabemos a quién actualizar
    nombre, edad, fecha_nac, entidad_fed, curp, domicilio, 
    cp, telefono, sexo, edo_civil, escolaridad, ref_medica, 
    servicio, motivo_estudio, 
    num_programa_actual,      // Flutter ahora envía este nombre exacto
    es_estimulacion_temprana 
  } = req.body;

  // 2. Validación básica
  if (!id_paciente) {
    return res.status(400).json({ error: "Falta el id_paciente para realizar la actualización." });
  }

  try {
    const query = `
      UPDATE paciente SET
        nombre = $1, 
        edad = $2, 
        fecha_nac = $3, 
        entidad_fed = $4, 
        curp = $5, 
        domicilio = $6, 
        cp = $7, 
        telefono = $8, 
        sexo = $9, 
        edo_civil = $10, 
        escolaridad = $11, 
        ref_medica = $12, 
        servicio = $13, 
        motivo_estudio = $14,
        es_estimulacion_temprana = $15,  -- Actualizamos si es E.T.
        num_programa_actual = $16        -- Actualizamos el nivel (ej. cambia de 1 a 2)
      WHERE id_paciente = $17;
    `;
    
    const values = [
      nombre, 
      edad, 
      fecha_nac, 
      entidad_fed, 
      curp, 
      domicilio, 
      cp, 
      telefono, 
      sexo, 
      edo_civil, 
      escolaridad, 
      ref_medica, 
      servicio, 
      motivo_estudio, 
      es_estimulacion_temprana, // $15
      num_programa_actual,      // $16
      id_paciente               // $17 (El filtro WHERE)
    ];

    await pool.query(query, values);
    
    // Respondemos éxito
    res.json({ message: "Paciente actualizado correctamente" });

  } catch (err) {
    console.error("Error en PUT /pacientes:", err);
    res.status(500).send("Error al actualizar paciente");
  }
});


// 🗑️ ELIMINAR PACIENTE (Solo si no tiene citas, que es el caso de esta lista)
app.delete("/pacientes/:id", async (req, res) => {
  const { id } = req.params;
  try {
    // Borramos directo de la tabla paciente
    const query = "DELETE FROM paciente WHERE id_paciente = $1";
    await pool.query(query, [id]);
    
    res.json({ message: "Paciente eliminado del sistema" });
  } catch (err) {
    console.error("Error al eliminar:", err);
    res.status(500).json({ error: "No se pudo eliminar" });
  }
});

// 📅 OBTENER DETALLE DE CITAS POR TERAPEUTA Y MES
// -----------------------------------------------------------
// 🔍 DETALLE DE CARGA DE TRABAJO (CORREGIDO PARA TIPOS Y PENDIENTES)
// -----------------------------------------------------------
app.get("/cargas-trabajo/detalle", async (req, res) => {
  const { idPersonal, mes, anio } = req.query;

  try {
    const query = `
      SELECT 
        c.id_cita,
        c.hora_inicio, 
        c.hora_fin, 
        c.tipo_cita, 
        -- 👇 ¡AGREGA ESTAS DOS LÍNEAS! 👇
        c.indice_val, 
        c.total_val,  
        -- 👆 SIN ESTO, FLUTTER SIEMPRE PONE "1 de 1" 👆
        
        EXTRACT(DAY FROM c.fecha) as dia_numero,
        p.nombre, 
        p.servicio, 
        p.fecha_registro,
        p.edad,
        p.telefono,
        p.motivo_estudio,
        p.ref_medica,
        p.domicilio,
        p.entidad_fed,
        p.cp,
        p.edo_civil,
        p.sexo,
        p.escolaridad,
        TO_CHAR(p.fecha_registro, 'DD/MM/YYYY') as fecha_registro_fmt,
        c.estatus
      FROM citas c
      JOIN paciente p ON c.id_paciente = p.id_paciente
      WHERE c.id_personal = $1
      AND EXTRACT(MONTH FROM c.fecha) = $2
      AND EXTRACT(YEAR FROM c.fecha) = $3
      
      AND c.estatus IN ('Agendada', 'En Curso', 'Reagendada', 'Pendiente') 
      
      ORDER BY c.fecha ASC, c.hora_inicio ASC;
    `;

    const result = await pool.query(query, [idPersonal, mes, anio]);
    res.json(result.rows);

  } catch (err) {
    console.error("Error en detalle carga:", err);
    res.status(500).json({ error: "Error al obtener detalle" });
  }
});
///////////////////////////////////////////

// -----------------------------------------------------------
// --- RUTA: CARTERA TOTAL - SOLUCIÓN DE TIPOS DE DATO 🧬 ---
// -----------------------------------------------------------
// -----------------------------------------------------------
// --- RUTA: CARTERA TOTAL - CORREGIDA Y EXPLICADA 🧠 ---
// -----------------------------------------------------------
app.get("/gestion/pacientes-activos-agrupados", async (req, res) => {
  try {
    const sql = `
      SELECT DISTINCT ON (p.id_paciente)
        p.id_paciente,
        p.nombre as nombre_paciente,
        p.num_programa_actual,
        p.telefono,
        p.fecha_registro,
        p.domicilio,
        p.curp,

        -- Datos de la cita (La más reciente encontrada)
        c.fecha,
        c.hora_inicio,
        c.asistencia,
        c.estatus as estatus_cita, -- Agregado para ver si fue cancelada/falta
        
        -- Datos del Personal
        per.id_personal,
        -- Si no tiene médico asignado, mostramos aviso
        COALESCE(per.nombre, 'SIN ASIGNAR') AS nombre_terapeuta,
        -- Si no tiene función, usamos 'CONSULTA EXTERNA' para que Flutter no lo esconda
        COALESCE(per.funcion, 'CONSULTA EXTERNA') AS area_terapeuta

      FROM citas c
      INNER JOIN paciente p ON c.id_paciente = p.id_paciente
      
      -- LEFT JOIN BLINDADO: Convierte IDs a texto para asegurar coincidencia
      LEFT JOIN personal per ON TRIM(CAST(c.id_personal AS VARCHAR)) = TRIM(CAST(per.id_personal AS VARCHAR))
      
      WHERE 
        -- ✅ CORRECCIÓN DEL BUG: Quitamos UPPER para comparar exacto
        TRIM(p.estatus_paciente) = 'Activo'

        -- ✅ NIVEL BLINDADO: Compara texto contra texto para evitar errores de tipo
        -- Y permite citas con nivel NULL (migradas/viejas)
        AND (
            TRIM(CAST(c.num_programa AS VARCHAR)) = TRIM(CAST(p.num_programa_actual AS VARCHAR))
            OR c.num_programa IS NULL
        )

      -- ✅ EL ORDENAMIENTO MÁGICO:
      -- Pone las citas futuras primero. Si no hay, pone las pasadas más recientes.
      ORDER BY p.id_paciente, c.fecha DESC;
    `;
    
    const result = await pool.query(sql);
    console.log(`✅ Pacientes Activos Encontrados: ${result.rows.length}`);
    res.json(result.rows);

  } catch (error) {
    console.error("🔥 Error Global:", error);
    res.status(500).json([]);
  }
});
// -----------------------------------------------------------
// --- RUTA: BUSCADOR GLOBAL BLINDADO (ENCUENTRA VIEJITOS Y NUEVOS) 🛡️ ---
// -----------------------------------------------------------
app.get("/gestion/buscar-paciente-global", async (req, res) => {
  const { q } = req.query; // q = lo que escribe el usuario

  if (!q) return res.json([]);

  try {
    const sql = `
      SELECT DISTINCT ON (p.id_paciente)
        p.id_paciente,
        p.nombre as nombre_paciente,
        p.num_programa_actual,
        p.telefono,
        p.domicilio,
        
        -- Datos de la cita
        c.fecha,
        c.hora_inicio,
        
        -- Datos del Personal (BLINDADO CON COALESCE Y CAST)
        -- Si no hay match exacto, ponemos valores por defecto para que no explote
        COALESCE(per.nombre, 'SIN ASIGNAR') AS nombre_terapeuta,
        COALESCE(per.funcion, 'CONSULTA EXTERNA') AS area_terapeuta

      FROM citas c
      INNER JOIN paciente p ON c.id_paciente = p.id_paciente
      
      -- LEFT JOIN BLINDADO: Convierte a texto para asegurar match aunque la BD tenga basura
      LEFT JOIN personal per ON TRIM(CAST(c.id_personal AS VARCHAR)) = TRIM(CAST(per.id_personal AS VARCHAR))
      
      WHERE 
        -- 1. Buscamos el nombre (Insensible a mayúsculas)
        p.nombre ILIKE $1 
        
        -- 2. Solo Pacientes Activos (Quitando espacios basura)
        AND TRIM(p.estatus_paciente) = 'Activo'

        -- 3. VALIDACIÓN DE NIVELES (La misma lógica de la lista principal)
        AND (
            TRIM(CAST(c.num_programa AS VARCHAR)) = TRIM(CAST(p.num_programa_actual AS VARCHAR))
            OR c.num_programa IS NULL
        )

      -- IMPORTANTE: Ya NO filtramos por fecha futura (c.fecha >= CURRENT_DATE fue eliminado)
      -- Esto permite que salgan los del año pasado.

      ORDER BY p.id_paciente, c.fecha DESC;
    `;
    
    // Ejecutamos la consulta
    const result = await pool.query(sql, [`%${q}%`]);
    console.log(`🔍 Buscando: "${q}" - Encontrados: ${result.rows.length}`);
    res.json(result.rows);

  } catch (error) {
    console.error("🔥 Error en Buscador Global:", error);
    res.status(500).json([]);
  }
});

// -----------------------------------------------------------
// --- RUTA: OBTENER CITAS (FILTRADO POR NIVEL ACTUAL) ---
// -----------------------------------------------------------
app.get("/gestion/citas-paciente/:id", async (req, res) => {
  const { id } = req.params;
  try {
    const sql = `
      SELECT 
        c.id_cita, 
        c.fecha, 
        c.hora_inicio AS hora,
        c.hora_inicio, 
        c.hora_fin, 
        c.estatus,
        c.id_personal,
        c.asistencia, 
        c.pago,
        -- Datos clave para colores
        c.tipo_cita,   
        c.indice_val,  
        c.total_val,
        c.num_programa, -- (Opcional) Para que veas en qué nivel está la cita

        per.nombre as nombre_terapeuta
      
      FROM citas c
      LEFT JOIN personal per ON c.id_personal = per.id_personal
      -- 👇 1. AGREGAMOS ESTE JOIN PARA LEER EL NIVEL DEL PACIENTE
      LEFT JOIN paciente pac ON c.id_paciente = pac.id_paciente
      
      WHERE c.id_paciente = $1

      -- 👇 2. EL FILTRO MÁGICO
      -- "La cita debe pertenecer al mismo programa en el que va el paciente hoy"
      AND c.num_programa = pac.num_programa_actual

      ORDER BY c.fecha DESC, c.hora_inicio ASC
    `;
    
    const result = await pool.query(sql, [id]);
    res.json(result.rows);

  } catch (error) {
    console.error("Error obteniendo citas paciente:", error);
    res.status(500).json({ error: "Error interno" });
  }
});


// -----------------------------------------------------------
// --- RUTA: ELIMINAR PACIENTE COMPLETAMENTE (NUCLEAR) ---
// -----------------------------------------------------------
app.delete("/gestion/eliminar-paciente/:id", async (req, res) => {
  const { id } = req.params;
  
  // Usamos un cliente dedicado para poder hacer TRANSACTION
  const client = await pool.connect();

  try {
    await client.query('BEGIN'); // --- INICIA LA TRANSACCIÓN ---

    // 1. Borrar historial
    await client.query('DELETE FROM historial_consultas WHERE id_paciente = $1', [id]);
    
    // 2. Borrar familiares
    await client.query('DELETE FROM familiar WHERE id_paciente = $1', [id]);

    // 3. Borrar citas
    await client.query('DELETE FROM citas WHERE id_paciente = $1', [id]);

    // 4. FINALMENTE, borrar al paciente
    await client.query('DELETE FROM paciente WHERE id_paciente = $1', [id]);

    await client.query('COMMIT'); // --- CONFIRMA LOS CAMBIOS ---
    
    res.json({ message: "Paciente eliminado totalmente." });

  } catch (error) {
    await client.query('ROLLBACK'); // Si algo falla, deshace todo
    console.error("🔥 Error eliminando paciente:", error);
    res.status(500).json({ error: "No se pudo eliminar al paciente." });
  } finally {
    client.release(); // Liberamos la conexión
  }
});

// -----------------------------------------------------------
// --- RUTA: ACTUALIZAR PACIENTE (COMPLETO - FASE 3C) ---
// -----------------------------------------------------------
app.put("/gestion/actualizar-paciente-full", async (req, res) => {
  const { 
    id_paciente, nombre, edad, fecha_nac, entidad_fed, curp, 
    domicilio, cp, telefono, sexo, edo_civil, escolaridad, 
    ref_medica, servicio, motivo_estudio, es_estimulacion_temprana,
    num_programa_actual 
  } = req.body;

  try {
    const sql = `
      UPDATE paciente
      SET 
        nombre = $1, 
        edad = $2, 
        fecha_nac = $3, 
        entidad_fed = $4,
        curp = $5, 
        domicilio = $6, 
        cp = $7, 
        telefono = $8,
        sexo = $9, 
        edo_civil = $10, 
        escolaridad = $11, 
        ref_medica = $12,
        servicio = $13, 
        motivo_estudio = $14, 
        es_estimulacion_temprana = $15,
        num_programa_actual = $16
      WHERE id_paciente = $17
    `;
    
    const result = await pool.query(sql, [
      nombre, edad, fecha_nac, entidad_fed, curp, 
      domicilio, cp, telefono, sexo, edo_civil, escolaridad, 
      ref_medica, servicio, motivo_estudio, es_estimulacion_temprana,
      num_programa_actual, id_paciente
    ]);
    
    // 🛡️ VALIDACIÓN EXTRA: ¿Se actualizó algo?
    if (result.rowCount === 0) {
      return res.status(404).json({ error: "No se encontró el ID del paciente." });
    }

    res.json({ message: "Expediente actualizado correctamente" });

  } catch (error) {
    console.error("🔥 Error actualizando expediente completo:", error);
    res.status(500).json({ error: "No se pudo actualizar la información en la base de datos." });
  }
});

// -----------------------------------------------------------
// --- RUTA: OBTENER PERFIL COMPLETO DE UN PACIENTE ---
// -----------------------------------------------------------
app.get("/gestion/paciente-detalle/:id", async (req, res) => {
  const { id } = req.params;
  try {
    const result = await pool.query("SELECT * FROM paciente WHERE id_paciente = $1", [id]);
    if (result.rows.length > 0) {
      res.json(result.rows[0]);
    } else {
      res.status(404).json({ error: "Paciente no encontrado" });
    }
  } catch (error) {
    console.error("🔥 Error obteniendo detalle:", error);
    res.status(500).json({ error: "Error de servidor" });
  }
});

// -----------------------------------------------------------
// --- RUTA: GUARDAR HORARIO (CORREGIDO: SIN AUTO-SABOTAJE) ✅ ---
// -----------------------------------------------------------
app.post("/gestion/guardar-horario-bloque", async (req, res) => {
  const { id_paciente, id_personal, citas_futuras, num_programa, servicio_area } = req.body;
  
  const client = await pool.connect();

  try {
    await client.query('BEGIN');

    // 1. FECHA DE CORTE
    const fechaHoy = new Date().toLocaleDateString('en-CA', { timeZone: 'America/Mexico_City' });
    console.log(`📅 Procesando ${citas_futuras.length} citas para Paciente ${id_paciente} desde ${fechaHoy}`);

    // =====================================================================
    // PASO 0: LIMPIEZA UNIVERSAL (Matar a los rivales)
    // =====================================================================
    // ... (Esta parte estaba bien, borra a los otros doctores) ...
    await client.query(`
        DELETE FROM historial_consultas WHERE id_cita IN (
            SELECT id_cita FROM citas WHERE id_paciente = $1 AND id_personal != $2 AND fecha >= $3::date AND estatus != 'Cancelada'
        )
    `, [id_paciente, id_personal, fechaHoy]);

    await client.query(`
        DELETE FROM citas WHERE id_paciente = $1 AND id_personal != $2 AND fecha >= $3::date AND estatus != 'Cancelada'
    `, [id_paciente, id_personal, fechaHoy]);
    
    // =====================================================================
    // PASO 1: INSERTAR Y PROTEGER (Aquí estaba el error)
    // =====================================================================
    
    // Traemos lo que YA existe con ESTE doctor
    const resultadoActuales = await client.query(`
      SELECT id_cita, fecha, hora_inicio FROM citas 
      WHERE id_paciente = $1 AND id_personal = $2 AND fecha >= $3::date AND estatus != 'Cancelada'
    `, [id_paciente, id_personal, fechaHoy]);
    
    const citasEnBaseDatos = resultadoActuales.rows;
    const idsParaMantener = []; // 🛡️ Lista de escudos

    for (const citaNueva of citas_futuras) {
      const fechaNuevaStr = new Date(citaNueva.fecha).toISOString().split('T')[0]; 
      
      const citaExistente = citasEnBaseDatos.find(dbCita => {
        const fechaDBStr = new Date(dbCita.fecha).toISOString().split('T')[0];
        return fechaDBStr === fechaNuevaStr;
      });

      if (citaExistente) {
        // --- UPDATE (Ya existía) ---
        idsParaMantener.push(citaExistente.id_cita); // 🛡️ ¡Protegida!

        const horaDB = citaExistente.hora_inicio.substring(0, 5); 
        const horaNueva = citaNueva.hora_inicio.substring(0, 5);

        if (horaDB !== horaNueva) {
          await client.query(`
            UPDATE citas SET hora_inicio = $1, hora_fin = $2 WHERE id_cita = $3
          `, [citaNueva.hora_inicio, citaNueva.hora_fin, citaExistente.id_cita]);
        }
      } else {
        // --- INSERT (Nueva) ---
        // ⚠️ CAMBIO CLAVE AQUÍ ABAJO 👇: Agregamos "RETURNING id_cita"
        const insertSql = `
          INSERT INTO citas (
            id_paciente, id_personal, fecha, hora_inicio, hora_fin, 
            num_programa, estatus, tipo_cita, asistencia, servicio_area, pago
          ) VALUES ($1, $2, $3, $4, $5, $6, 'Agendada', 'A', 0, $7, 0)
          RETURNING id_cita; 
        `;
        
        const resInsert = await client.query(insertSql, [
            id_paciente,
            id_personal,
            citaNueva.fecha,
            citaNueva.hora_inicio,
            citaNueva.hora_fin,
            num_programa,
            servicio_area || 'Consulta Externa'
        ]);

        // 🛡️ ¡IMPORTANTE! Agregamos la nueva cita a la lista de protección
        // Si no hacemos esto, el paso de limpieza la borrará.
        if (resInsert.rows.length > 0) {
            idsParaMantener.push(resInsert.rows[0].id_cita);
        }
      }
    }

    // =====================================================================
    // PASO 2: LIMPIEZA FINAL (Solo lo que NO está protegido)
    // =====================================================================
    
    console.log(`🛡️ Citas protegidas (IDs): ${idsParaMantener.length}`);

    let clausulaExclusion = "";
    if (idsParaMantener.length > 0) {
      clausulaExclusion = `AND id_cita NOT IN (${idsParaMantener.join(',')})`;
    }

    // Ahora sí, el DELETE respeta las nuevas porque sus IDs ya están en la lista
    const sqlBorrarSobras = `
        DELETE FROM citas 
        WHERE id_paciente = $1 
          AND id_personal = $2 
          AND fecha >= $3::date
          AND estatus != 'Cancelada'
          ${clausulaExclusion}
    `;
    
    // Primero borramos historial huérfano (misma lógica)
    await client.query(`
       DELETE FROM historial_consultas WHERE id_cita IN (
          SELECT id_cita FROM citas WHERE id_paciente = $1 AND id_personal = $2 AND fecha >= $3::date AND estatus != 'Cancelada' ${clausulaExclusion}
       )
    `, [id_paciente, id_personal, fechaHoy]);

    await client.query(sqlBorrarSobras, [id_paciente, id_personal, fechaHoy]);

    await client.query('COMMIT');
    res.json({ message: "Horario sincronizado correctamente" });

  } catch (error) {
    await client.query('ROLLBACK');
    console.error("🔥 Error guardando bloque:", error);
    res.status(500).json({ error: "Error: " + error.message });
  } finally {
    client.release();
  }
});
// -----------------------------------------------------------
// --- RUTA FINAL: EDICIÓN HISTORIAL COMPLETA (DINERO + ESTATUS + NOTA) ---
// -----------------------------------------------------------
app.patch("/editar-cita-historial", async (req, res) => {
  // 1. RECIBIMOS EL PAGO TAMBIÉN
  const { id_cita, asistencia, observacion, pago } = req.body;
  
  const client = await pool.connect();
  
  try {
    await client.query('BEGIN'); 

    // 2. Preparamos el monto (si viene nulo, ponemos 0)
    const montoFinal = pago || 0;

    // 3. ACTUALIZAMOS CITA: Asistencia, PAGO y Estatus Automático
    const sqlCita = `
      UPDATE citas 
      SET 
        asistencia = $1,
        pago = $2, -- <--- 💰 AQUÍ GUARDAMOS EL DINERO QUE FALTABA
        
        estatus = CASE 
            -- Regla 1: Si es Primera Vez (P) y Única (1 de 1) -> 'Realizada'
            WHEN tipo_cita = 'P' AND total_val = 1 THEN 'Realizada'
            
            -- Regla 2: Tratamientos (A) o Bloques -> 'Finalizada'
            ELSE 'Finalizada'
        END
      WHERE id_cita = $3
    `;
    
    // OJO: Enviamos [asistencia, montoFinal, id_cita]
    await client.query(sqlCita, [asistencia, montoFinal, id_cita]);

    // 4. HISTORIAL: Actualizar o Crear comentario (Igual que antes)
    const checkSql = `SELECT id_historial FROM historial_consultas WHERE id_cita = $1`;
    const checkResult = await client.query(checkSql, [id_cita]);

    if (checkResult.rowCount > 0) {
      // A) UPDATE
      const updateHistorial = `UPDATE historial_consultas SET observaciones = $1 WHERE id_cita = $2`;
      await client.query(updateHistorial, [observacion, id_cita]);
    } else {
      // B) INSERT
      const datosCita = await client.query('SELECT id_paciente FROM citas WHERE id_cita = $1', [id_cita]);
      
      if (datosCita.rows.length > 0) {
        const { id_paciente } = datosCita.rows[0];
        const insertHistorial = `
          INSERT INTO historial_consultas (id_cita, id_paciente, observaciones)
          VALUES ($1, $2, $3)
        `;
        await client.query(insertHistorial, [id_cita, id_paciente, observacion]);
      }
    }

    await client.query('COMMIT'); 
    res.json({ message: "Guardado: Asistencia, Pago y Estatus actualizados" });

  } catch (error) {
    await client.query('ROLLBACK');
    console.error("🔥 Error:", error);
    res.status(500).json({ error: error.message });
  } finally {
    client.release();
  }
});

// -----------------------------------------------------------
// --- RUTA: BUSCAR PERSONAL POR ÁREA (VERSIÓN FINAL SEGÚN FOTO) ---
// -----------------------------------------------------------
app.get("/personal-por-area", async (req, res) => {
  const { area } = req.query; 

  if (!area) return res.json([]);

  const client = await pool.connect();
  try {
    // 👇 CORRECCIÓN: 
    // 1. Buscamos en 'funcion' (que es la columna que tienes para el puesto)
    // 2. Quitamos 'estatus' porque no sale en tu foto (para evitar otro error)
    const sql = `
      SELECT id_personal, nombre 
      FROM personal 
      WHERE funcion ILIKE $1
    `;
    
    // El % permite que si buscas "Psicologia" encuentre "Psicologo"
    const result = await client.query(sql, [`%${area}%`]);
    
    const lista = result.rows.map(p => ({
      id_personal: p.id_personal,
      nombre: p.nombre 
    }));

    res.json(lista);

  } catch (error) {
    console.error("Error buscando personal:", error);
    res.status(500).json([]);
  } finally {
    client.release();
  }
});

// -----------------------------------------------------------
// 🕒 RUTA: HISTORIAL DE CITAS (SOLO VISUAL - SIN EXCEL)
// -----------------------------------------------------------
app.get("/citas-historial", async (req, res) => {
  const { fecha, especialidad } = req.query;

  // 1. Validamos que mandes los datos
  if (!fecha || !especialidad) {
    return res.status(400).json({ error: "Faltan parámetros 'fecha' o 'especialidad'." });
  }

  const client = await pool.connect();
  try {
    // 2. Truco para ignorar acentos (Psicología = Psicologia)
    const espOriginal = especialidad.trim();
    // Quitamos acentos:
    const espSinAcento = espOriginal.normalize("NFD").replace(/[\u0300-\u036f]/g, "");

    console.log(`🔎 Buscando historial para: ${fecha} - ${espOriginal}`);

    // 3. SQL: Traemos las citas
    const sql = `
        SELECT 
            c.id_cita,
            TO_CHAR(c.hora_inicio, 'HH24:MI') AS hora_inicio,
            TO_CHAR(c.hora_fin, 'HH24:MI') AS hora_fin,
            p.nombre AS nombre_paciente,
            pe.nombre AS nombre_tratante,
            c.servicio_area, 
            c.asistencia,
            c.pago,
            c.estatus
        FROM citas c
        JOIN paciente p ON c.id_paciente = p.id_paciente
        LEFT JOIN personal pe ON c.id_personal = pe.id_personal
        WHERE c.fecha = $1
        -- Buscamos con o sin acento para asegurar que encuentre todo
        AND (LOWER(c.servicio_area) = LOWER($2) OR LOWER(c.servicio_area) = LOWER($3))
        ORDER BY c.hora_inicio ASC
    `;

    const result = await client.query(sql, [fecha, espOriginal, espSinAcento]);

    // 4. AGRUPACIÓN (Para que se vea bonito en Flutter)
    const grupos = {};

    result.rows.forEach(row => {
        const nombreProf = row.nombre_tratante || "POR ASIGNAR";

        if (!grupos[nombreProf]) {
            grupos[nombreProf] = {
                nombreProfesional: nombreProf,
                especialidad: row.servicio_area,
                conteoPacientes: 0,
                pacientes: []
            };
        }

        grupos[nombreProf].pacientes.push({
            idCita: row.id_cita,
            nombrePaciente: row.nombre_paciente,
            horaInicio: row.hora_inicio,
            horaFin: row.hora_fin,
            asistencia: row.asistencia, 
            pago: row.pago ? parseFloat(row.pago) : 0,
            estatus: row.estatus
        });

        grupos[nombreProf].conteoPacientes++;
    });

    // 5. Enviamos la respuesta limpia
    const respuestaFinal = Object.values(grupos);
    res.status(200).json(respuestaFinal);

  } catch (error) {
    console.error("🔥 Error en /citas-historial:", error);
    res.status(500).json({ error: "Error interno del servidor" });
  } finally {
    client.release();
  }
});


///////////////////////////////////////////
// INICIO DEL SERVIDOR (Correcto)
// ---------------------------
app.listen(PORT, '0.0.0.0', () => {
  console.log(`🚀 Servidor corriendo en http://localhost:${PORT} (y accesible en tu red)`);
  console.log(`🕒 Hora actual del sistema: ${new Date().toString()}`);
});