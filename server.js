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
// FUNCIÓN CENTRAL: Consulta de Datos de Reporte (Antigua)
// -----------------------------------------------------------------
async function queryReportData(client, type, year, month, limitRows = false) {
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
            c.pago,
            c.motivo_pago,
            c.tipo_cita
        FROM citas c
        JOIN paciente p ON c.id_paciente = p.id_paciente
        JOIN personal pe ON c.id_personal = pe.id_personal
        WHERE 1=1 
    `;
    let params = [];
    let filterIndex = 1;

    // --- LÓGICA DE FILTRADO DE FECHAS (Genera YYYY-MM-DD) ---
    if (type === 'mensual' && month) {
        const fechaInicio = `${year}-${month}-01`;
        const lastDay = new Date(year, parseInt(month), 0).getDate(); 
        const fechaFin = `${year}-${month}-${lastDay}`;
        
        sql += ` AND c.fecha BETWEEN $${filterIndex++} AND $${filterIndex++}`;
        params.push(fechaInicio, fechaFin);
        
    } else if (type === 'anual') {
        const fechaInicio = `${year}-01-01`;
        const fechaFin = `${year}-12-31`;
        
        sql += ` AND c.fecha BETWEEN $${filterIndex++} AND $${filterIndex++}`;
        params.push(fechaInicio, fechaFin);
    } else {
        throw new Error("Filtros de fecha no válidos.");
    }
    
    sql += ` ORDER BY c.fecha ASC, c.hora_inicio ASC`;
    // Aplicar límite si es para vista previa
    if (limitRows) {
        sql += ` LIMIT 20`;
    }

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

// --- Función helper para generar el reporte Excel (Antiguo) ---
async function generateExcelReport(data, fileName, filterInfo) {
    const workbook = new ExcelJS.Workbook();
    const worksheet = workbook.addWorksheet('Reporte de Citas');

    // ESTILO DE ENCABEZADO PARA TABLA COMPLEJA
    const headerStyle = {
        font: { bold: true, color: { argb: 'FFFFFFFF' } }, // Texto blanco
        fill: { type: 'pattern', pattern: 'solid', fgColor: { argb: 'FF4F81BD' } }, // Azul oscuro
        alignment: { vertical: 'middle', horizontal: 'center' }, // Centrado
        border: { 
            top: { style: 'thin' }, 
            left: { style: 'thin' }, 
            bottom: { style: 'thin' }, 
            right: { style: 'thin' } 
        }
    };
    // ESTILO DE CELDAS DE DATOS
    const dataStyle = {
        alignment: { vertical: 'middle', horizontal: 'center' }, // Centrado de texto
        border: { 
            top: { style: 'thin', color: { argb: 'FFD9D9D9' } }, // Borde gris claro
            left: { style: 'thin', color: { argb: 'FFD9D9D9' } }, 
            bottom: { style: 'thin', color: { argb: 'FFD9D9D9' } }, 
            right: { style: 'thin', color: { argb: 'FFD9D9D9' } } 
        }
    };
    // Configuración de columnas (incluye estilo para centrar encabezados)
    worksheet.columns = [
        { header: 'ID Paciente', key: 'id_paciente', width: 15, style: headerStyle },
        { header: 'Paciente', key: 'nombre_paciente', width: 30, style: headerStyle },
        { header: 'Fecha Cita', key: 'fecha', width: 15, style: headerStyle },
        { header: 'Inicio', key: 'hora_inicio', width: 10, style: headerStyle },
        { header: 'Fin', key: 'hora_fin', width: 10, style: headerStyle },
        { header: 'Tratante', key: 'nombre_tratante', width: 30, style: headerStyle },
        { header: 'Servicio', key: 'servicio_area', width: 20, style: headerStyle },
        { header: 'Estatus', key: 'estatus', width: 15, style: headerStyle },
        { header: 'Tipo', key: 'tipo_cita', width: 8, style: headerStyle },
        { header: 'Pago', key: 'pago', width: 10, style: { numFmt: '"\$"#,##0.00', ...headerStyle } },
    ];

    // Fila de Título del Reporte
    worksheet.mergeCells('A1:J1');
    worksheet.getCell('A1').value = `REPORTE DE CITAS: ${filterInfo} (${data.length} Registros)`;
    worksheet.getCell('A1').font = { bold: true, size: 14 };
    worksheet.getCell('A1').alignment = { vertical: 'middle', horizontal: 'center' };

    worksheet.addRow([]); // Fila vacía
    worksheet.addRow(worksheet.columns.map(col => col.header)); // Fila de encabezados reales (fila 3)
    
    // Aplicar estilo de encabezado a la fila 3
    for (let i = 1; i <= worksheet.columns.length; i++) {
        worksheet.getCell(3, i).style = headerStyle;
    }

    // Agregar datos y aplicar estilo
    let rowIndex = 4;
    data.forEach(row => {
        const formattedRow = {
            ...row,
            fecha: row.fecha ? row.fecha.toISOString().split('T')[0] : '', // Formato YYYY-MM-DD
        };
        const newRow = worksheet.addRow(formattedRow);
        
        // Aplicar estilo de datos a toda la fila, centrado para todas las celdas
        newRow.eachCell({ includeEmpty: false }, (cell, colNumber) => {
            // Estilo general para centrado y bordes
            cell.style = { ...cell.style, ...dataStyle };
            
            // Excepción para el nombre del paciente y tratante (justificado a la izquierda si lo prefieres)
            if (colNumber === 2 || colNumber === 6) { 
                cell.alignment = { vertical: 'middle', horizontal: 'left' };
            } 
            
            // Ajustar el formato de número de pago
            if (colNumber === 10) {
                cell.numFmt = '"\$"#,##0.00';
            }
        });
        rowIndex++;
    });
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
// 👁️ RUTA: VISTA PREVIA DE DATOS (PREVIEW) - Método GET (Antigua)
// -----------------------------------------------------------
app.get("/preview-report-data", async (req, res) => {
    const { type, year, month } = req.query;
    
    if (!type || !year) {
        return res.status(400).json({ error: "Faltan parámetros 'type' o 'year'." });
    }

    const client = await pool.connect();
    try {
        const previewData = await queryReportData(client, type, year, month, true);
        
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
// 📊 RUTA DE GENERACIÓN DE REPORTES (GENERATE) - Método POST (Antigua)
// -----------------------------------------------------------
app.post("/generate-report", async (req, res) => {
    const { type, year, month } = req.body;
    
    if (!type || !year) {
        return res.status(400).json({ error: "Faltan parámetros 'type' o 'year'." });
    }

    const client = await pool.connect();
    try {
        const reportData = await queryReportData(client, type, year, month, false);
        
        if (reportData.length === 0) {
            return res.status(404).json({ 
                error: "No se encontraron datos para generar el reporte.", 
                detalle: "La base de datos no contiene citas en ese periodo." 
            });
        }
        
        const monthNames = [
            'enero', 'febrero', 'marzo', 'abril', 'mayo', 'junio',
            'julio', 'agosto', 'septiembre', 'octubre', 'noviembre', 'diciembre'
        ];
        
        let fileNameBase;
        let filterInfo;
        if (type === 'mensual' && month) {
            const monthIndex = parseInt(month, 10) - 1;
            const monthName = monthNames[monthIndex];
            fileNameBase = `reporte_citas_${monthName}_${year}`; 
            filterInfo = `${monthName.toUpperCase()}/${year}`;
        } else if (type === 'anual') {
            fileNameBase = `reporte_citas_anual_${year}`; 
            filterInfo = `${year}`;
        } else {
            fileNameBase = `reporte_citas_general`; 
            filterInfo = 'General';
        }

        const serverBaseUrl = "http://localhost:3000";
        await generateExcelReport(reportData, fileNameBase, filterInfo);
        const pdfFileName = `${fileNameBase}.pdf`;
        fs.writeFileSync(path.join(reportsDir, pdfFileName), `Documento PDF simulado. Por favor, descargue el Excel.`);
        
        const pdfUrl = `${serverBaseUrl}/reports/${pdfFileName}`;
        const excelUrl = `${serverBaseUrl}/reports/${fileNameBase}.xlsx`;
        console.log(`✅ Reporte Excel generado y PDF simulado. Registros: ${reportData.length}`);
        
        res.status(200).json({
            message: "Reporte generado con éxito.",
            pdfUrl: pdfUrl,
            excelUrl: excelUrl,
            dataCount: reportData.length,
        });
    } catch (error) {
        console.error("🔥 Error fatal en /generate-report:", error);
        res.status(500).json({ error: "Error al generar el reporte", detalle: error.message });
    } finally {
        client.release();
    }
});


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
// --- RUTA: MONITOR DE BAJAS (Actualizada con Filtro de Programa) ---
// -----------------------------------------------------------
// -----------------------------------------------------------
// --- RUTA: MONITOR DE BAJAS (CORREGIDA: Estructura Anidada + Observaciones) ---
// -----------------------------------------------------------
app.get("/pacientes-con-faltas", async (req, res) => {
  const { departamento, tipo_programa } = req.query; 
  // tipo_programa: 'tratamiento' | 'valoracion'

  const client = await pool.connect();
  try {
    let filtroPrograma = "";
    
    // 1. Filtro inteligente según pestaña
    if (tipo_programa === 'valoracion') {
      // Valoración: Citas P o V que sean parte de un bloque (más de 1)
      filtroPrograma = "AND (c.tipo_cita = 'P' OR c.tipo_cita = 'V') AND c.total_val > 1";
    } else {
      // Tratamiento: Citas tipo A
      filtroPrograma = "AND c.tipo_cita = 'A'";
    }

    const sql = `
      SELECT 
        p.id_paciente,
        p.nombre,
        p.servicio,
        p.telefono,
        
        -- Datos de la Cita con Incidencia
        c.id_cita,
        c.fecha,
        c.asistencia, -- 1, 2, 3, 5
        c.tipo_cita,
        c.indice_val,
        c.total_val,
        
        -- Observación específica de ESTA cita (si existe en historial)
        hc.observaciones
        
      FROM citas c
      JOIN paciente p ON c.id_paciente = p.id_paciente
      -- Join para traer el comentario de la falta
      LEFT JOIN historial_consultas hc ON c.id_cita = hc.id_cita
      
      WHERE 
        c.asistencia IN (1, 2, 3, 5) -- Faltas (1,2,3) o Retardos (5)
        AND p.estatus_paciente = 'Activo'
        ${filtroPrograma}
        ${departamento ? "AND c.servicio_area = $1" : ""}
      
      ORDER BY p.nombre ASC, c.fecha DESC;
    `;

    const params = departamento ? [departamento] : [];
    const result = await client.query(sql, params);

    // 3. AGRUPAMIENTO (Transformar lista plana a Jerárquica)
    // Flutter espera: [ { nombre: "Juan", historial: [ {fecha: "...", asistencia: 1}, ... ] } ]
    
    const pacientesMap = {};

    result.rows.forEach(row => {
      // Si el paciente no está en el mapa, lo creamos
      if (!pacientesMap[row.id_paciente]) {
        pacientesMap[row.id_paciente] = {
          id_paciente: row.id_paciente,
          nombre: row.nombre,
          servicio: row.servicio,
          telefono: row.telefono,
          historial: [] // Array vacío para llenarlo
        };
      }

      // Agregamos la incidencia al historial de ese paciente
      pacientesMap[row.id_paciente].historial.push({
        id_cita: row.id_cita,
        fecha: row.fecha,
        asistencia: row.asistencia,
        tipo: row.tipo_cita,
        observacion: row.observaciones, // <--- AQUÍ VA EL COMENTARIO
        info_val: row.total_val > 1 ? `(${row.indice_val}/${row.total_val})` : ""
      });
    });

    // Convertimos el mapa a array para enviarlo
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
app.get("/pacientes-por-finalizar", async (req, res) => {
  const client = await pool.connect();
  try {
    const sql = `
      SELECT 
        p.*,
        c.id_cita, c.fecha, c.hora_inicio, c.asistencia, c.tipo_cita, c.num_programa, c.servicio_area,
        per.nombre as nombre_tratante,
        hc.observaciones -- <--- IMPORTANTE: El comentario del doctor
      FROM citas c
      JOIN paciente p ON c.id_paciente = p.id_paciente
      LEFT JOIN personal per ON c.id_personal = per.id_personal
      LEFT JOIN historial_consultas hc ON c.id_cita = hc.id_cita
      WHERE c.tipo_cita = 'A' AND p.estatus_paciente = 'Activo'
      AND c.num_programa = (SELECT MAX(num_programa) FROM citas WHERE id_paciente = p.id_paciente)
      ORDER BY p.nombre ASC, c.fecha DESC;
    `;

    const result = await client.query(sql);

    // --- AGRUPAMIENTO INTELIGENTE ---
    // Transformamos la lista plana en objetos Paciente con su array de citas
    const pacientesMap = {};

    result.rows.forEach(row => {
      if (!pacientesMap[row.id_paciente]) {
        pacientesMap[row.id_paciente] = {
          // Datos del Paciente (Flattened)
          id_paciente: row.id_paciente,
          nombre: row.nombre,
          servicio: row.servicio,
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
          
          programa_actual: row.num_programa,
          historial: [] // Aquí meteremos las citas
        };
      }

      // Agregamos la cita al historial
      pacientesMap[row.id_paciente].historial.push({
        id_cita: row.id_cita,
        fecha: row.fecha,
        hora: row.hora_inicio,
        asistencia: row.asistencia,
        tratante: row.nombre_tratante,
        observacion: row.observaciones // <--- EL COMENTARIO QUE QUERÍAS
      });
    });

    // --- FILTRO FINAL ---
    // Solo devolvemos pacientes que ya terminaron su última cita registrada
    // (Opcional: Si quieres ver a todos los que tienen programa activo, quita este filtro)
    const listaFinal = Object.values(pacientesMap).filter(p => {
       // Ordenamos historial por fecha (más reciente primero)
       if (p.historial.length === 0) return false;
       
       // Verificamos si la fecha de la última cita ya pasó
       // const ultimaCita = new Date(p.historial[0].fecha);
       // const hoy = new Date();
       // return ultimaCita <= hoy; 
       
       return true; // Por ahora devolvemos todos los activos con programa 'A'
    });

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
  const tipoCita = tipo || 'P';

  if (!especialidad) return res.status(400).json({ error: "Falta especialidad" });

  const client = await pool.connect();
  try {
    // ... (Lógica del filtroLogico igual, se mantiene implícita en las queries abajo) ...

    // --- CONSULTA 1: Profesionales (INTACTA) ---
    const sqlProfesionalesDirecta = `
      SELECT DISTINCT
        pe.id_personal,
        pe.nombre AS nombre_profesional,
        pe.funcion AS especialidad
      FROM personal pe
      JOIN citas c ON pe.id_personal = c.id_personal
      WHERE
        c.fecha = CURRENT_DATE
        AND unaccent(TRIM(c.servicio_area)) ILIKE unaccent($2) 
        AND (
            ($1 = 'P' AND c.tipo_cita = 'P' AND (c.asistencia IS NULL OR c.asistencia = 0))
            OR
            ($1 = 'A' AND (c.tipo_cita = 'V' OR c.tipo_cita = 'A'))
        )
    `;

    const resProfesionales = await client.query(sqlProfesionalesDirecta, [tipoCita, especialidad]);
    const profesionales = resProfesionales.rows;

    if (profesionales.length === 0) return res.json([]);

    // --- CONSULTA 2: Pacientes (AQUÍ AGREGAMOS LOS DATOS EXTRA) ---
    const idsProfesionales = profesionales.map(p => p.id_personal);

    const sqlPacientes = `
      SELECT
        c.id_cita, c.id_personal, c.id_paciente, c.asistencia, c.indice_val, c.total_val,
        pa.nombre AS nombre_paciente,
        
        -- >>>> INICIO DE DATOS AGREGADOS (Solo esto es nuevo) <<<<
        pa.motivo_estudio,
        pa.servicio,
        pa.fecha_nac,
        pa.domicilio,
        pa.telefono,
        pa.tel_domicilio,
        pa.edad,
        pa.sexo,
        pa.ocupacion,
        edo_civil,
        pa.escolaridad,
        pa.entidad_fed,
        pa.cp,
        pa.num_consultorio,
        -- >>>> FIN DE DATOS AGREGADOS <<<<
        c.servicio_area,
        TO_CHAR(c.hora_inicio, 'HH24:MI') AS hora_inicio,
        TO_CHAR(c.hora_fin, 'HH24:MI') AS hora_fin,
        c.tipo_cita
      FROM citas c
      JOIN paciente pa ON c.id_paciente = pa.id_paciente
      WHERE
        c.id_personal = ANY($1::int[])
        AND c.fecha = CURRENT_DATE
        AND unaccent(TRIM(c.servicio_area)) ILIKE unaccent($3)
        AND (
            ($2 = 'P' AND c.tipo_cita = 'P' AND (c.asistencia IS NULL OR c.asistencia = 0))
            OR
            ($2 = 'A' AND (c.tipo_cita = 'V' OR c.tipo_cita = 'A'))
        )
      ORDER BY c.hora_inicio;
    `;
    
    // Mantenemos los 3 parámetros exactamente como los tenías
    const resPacientes = await client.query(sqlPacientes, [idsProfesionales, tipoCita, especialidad]);
    
    // --- FUSIÓN DE DATOS (INTACTA) ---
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
});;
/***********************************************************************************************************************************************************/



// -----------------------------------------------------------
// --- RUTA DE DIRECTORIO / BÚSQUEDA PERSONAL ---
// -----------------------------------------------------------
app.get("/buscar-personal", async (req, res) => {
  const { query } = req.query; 

  const client = await pool.connect();
  try {
    let sql = "";
    let params = [];

    if (query && query.trim() !== "") {
      // CASO 1: Búsqueda específica
      sql = `
        SELECT id_personal, nombre, funcion AS especialidad
        FROM personal
        WHERE unaccent(nombre) ILIKE unaccent($1)
        ORDER BY funcion, nombre; -- Ordenamos por depto siempre
      `;
      params = [`%${query}%`];
    } else {
      // CASO 2: Traer TODO el directorio (Para la lista inicial)
      sql = `
        SELECT id_personal, nombre, funcion AS especialidad
        FROM personal
        ORDER BY funcion, nombre; 
      `;
    }

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
app.post("/crear-cita", async (req, res) => {
  const { paciente, cita } = req.body;

  if (!paciente || !cita || !paciente.nombre || !cita.id_personal || !cita.fecha || !cita.hora_inicio) {
    return res.status(400).json({ error: "Faltan datos del paciente o de la cita" });
  }

  const numPrograma = paciente.num_programa || 1;

  const client = await pool.connect();

  try {
    await client.query("BEGIN");
    
    let nuevoPacienteId;

    // --- 1. GESTIÓN DEL PACIENTE ---
    if (paciente.id_paciente) {
        // CASO A: PACIENTE EXISTENTE (Referencia / Reagendado)
        console.log(`🔄 Actualizando Paciente ID: ${paciente.id_paciente} para Referencia/Cambio`);
        nuevoPacienteId = paciente.id_paciente;

        // --- CORRECCIÓN AQUÍ: AGREGAMOS MOTIVO Y SERVICIO ---
        const sqlUpdatePac = `
             UPDATE paciente SET
                domicilio = $1, 
                telefono = $2, 
                edad = $3,
                motivo_estudio = $4,  -- <--- Nuevo Motivo (Referencia)
                servicio = $5         -- <--- Nuevo Servicio
             WHERE id_paciente = $6
        `;
        
        await client.query(sqlUpdatePac, [
            paciente.domicilio, 
            paciente.telefono, 
            paciente.edad,
            paciente.motivo_estudio, // $4
            paciente.servicio,       // $5
            nuevoPacienteId          // $6
        ]);

    } else {
        // CASO B: NUEVO INGRESO (Recepción)
        // Esto NO cambia, sigue funcionando igual para los nuevos.
        console.log("🆕 Creando nuevo paciente...");
        const sqlInsertPaciente = `
          INSERT INTO paciente (
              nombre, edad, fecha_nac, entidad_fed, curp, domicilio, 
              cp, telefono, sexo, edo_civil, escolaridad, ref_medica, 
              servicio, motivo_estudio, estatus_paciente
          )
          VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9, $10, $11, $12, $13, $14, 'Activo')
          RETURNING id_paciente; 
        `;
        const p = paciente;
        const valores = [p.nombre, p.edad, p.fecha_nac, p.entidad_fed, p.curp, p.domicilio, p.cp, p.telefono, p.sexo, p.edo_civil, p.escolaridad, p.ref_medica, p.servicio, p.motivo_estudio];

        const pacienteResult = await client.query(sqlInsertPaciente, valores);
        nuevoPacienteId = pacienteResult.rows[0].id_paciente;
    }

    // --- 2. INSERTAR LA CITA 'P' ---
    const sqlInsertCita = `
      INSERT INTO citas (
          id_paciente, id_personal, fecha, hora_inicio, hora_fin, 
          servicio_area, estatus, tipo_cita, num_programa, indice_val, total_val
      )
      VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9, 1, 1);
    `;

    const citaValues = [
      nuevoPacienteId,     // $1
      cita.id_personal,    // $2
      cita.fecha,          // $3
      cita.hora_inicio,    // $4
      cita.hora_fin,       // $5
      paciente.servicio,   // $6 (Area destino)
      'Agendada',          // $7
      'P',                 // $8
      numPrograma          // $9
    ];

    await client.query(sqlInsertCita, citaValues);
    console.log(`✅ Cita creada (Prog ${numPrograma}) y datos actualizados.`);

    await client.query("COMMIT");
    res.status(201).json({
      message: "Cita creada exitosamente",
      id_paciente: nuevoPacienteId,
    });

  } catch (err) {
    await client.query("ROLLBACK");
    console.error("🔥 Error en POST /crear-cita:", err);
    res.status(500).json({ error: "Error interno del servidor" });
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
// --- RUTA ACTUALIZADA: Actualizar Asistencia + Cambiar a 'V' ---
// -----------------------------------------------------------
app.patch("/actualizar-asistencia", async (req, res) => {
  const { id_cita, asistencia } = req.body;

  if (!id_cita || !asistencia) {
    return res.status(400).json({ error: "Faltan datos (id_cita o asistencia)" });
  }

  const client = await pool.connect();
  try {
    console.log(`\n--- 🕵️‍♂️ ACTUALIZANDO CITA ID: ${id_cita} ---`);
    console.log(`Status: P -> V | Asistencia: ${asistencia}`);

    // --- ¡AQUÍ ESTÁ LA MAGIA! ---
    // Ahora actualizamos 3 cosas de un golpe:
    // 1. asistencia (El número 1-5)
    // 2. tipo_cita (Pasa a 'V' para historial)
    // 3. estatus (Pasa a 'Realizada' para limpieza)
    const sqlUpdate = `
      UPDATE citas 
      SET 
        asistencia = $1,
        tipo_cita = 'V',      -- <--- ESTO ES LO QUE FALTABA
        estatus = 'Realizada' 
      WHERE id_cita = $2
    `;
    
    await client.query(sqlUpdate, [asistencia, id_cita]);

    console.log("✅ Cita actualizada y cerrada correctamente.");
    res.json({ message: "Incidencia registrada y cita cerrada." });

  } catch (error) {
    console.error("🔥 Error al actualizar asistencia:", error);
    res.status(500).json({ error: "Error interno del servidor" });
  } finally {
    client.release();
  }
});


// -----------------------------------------------------------
// --- RUTA: IMPREVISTOS (CORREGIDA: Filtra solo Activos) ---
// -----------------------------------------------------------
// -----------------------------------------------------------
// --- RUTA: IMPREVISTOS (CORREGIDA: Filtra si ya tiene cita agendada) ---
// -----------------------------------------------------------
// -----------------------------------------------------------
// --- RUTA: IMPREVISTOS (Con detector de Historial Previo) ---
// -----------------------------------------------------------
// -----------------------------------------------------------
// --- RUTA: IMPREVISTOS (FINAL: Con Observaciones y Reagendados) ---
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
        hc.observaciones
        c.tipo_cita,
        c.id_cita,
        c.num_programa,
        c.servicio_area,
        -- 1. ¿Tiene historial de éxito previo?
        (
            SELECT COUNT(*) > 0 
            FROM citas historial 
            WHERE historial.id_paciente = p.id_paciente 
            AND historial.asistencia = 4
        ) as tiene_historial,

        -- 2. NUEVO CAMPO: OBSERVACIONES DEL TRATANTE
        -- Buscamos qué escribió el médico en el historial para esta cita específica
        (
            SELECT hc.observaciones 
            FROM historial_consultas hc 
            WHERE hc.id_cita = c.id_cita 
            LIMIT 1
        ) as observaciones

      FROM citas c
      JOIN paciente p ON c.id_paciente = p.id_paciente
      JOIN personal per ON c.id_personal = per.id_personal
      WHERE 
        c.asistencia IN (1, 2, 3)       -- Faltas (Justificada, Injustificada, Tratante)
        AND p.estatus_paciente = 'Activo'
        -- AND c.num_programa = 1       <-- (Eliminado para aceptar reagendados)
        AND c.indice_val = 1            -- Primera cita del bloque
        AND (c.tipo_cita = 'V' OR c.tipo_cita = 'P') -- Valoraciones
        AND c.total_val = 1             -- Citas únicas
        
        -- Que no tenga ya otra cita "Agendada" para rescatarlo
        AND NOT EXISTS (
            SELECT 1 FROM citas c2 
            WHERE c2.id_paciente = c.id_paciente 
            AND c2.estatus = 'Agendada' 
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
  const { 
    datosPaciente, 
    listaCitas, 
    idPersonal, 
    idPacienteExistente, 
    idCitaOrigen, 
    asistenciaOrigen 
  } = req.body;

  // Debug inicial para ver qué llega
  console.log("\n--- 📦 DEBUG: CREAR BLOQUE ---");
  console.log("ID Paciente Existente:", idPacienteExistente);
  console.log("Motivo Recibido:", datosPaciente?.motivo_estudio);
  console.log("Servicio Recibido:", datosPaciente?.servicio);

  if (!listaCitas || listaCitas.length === 0 || !idPersonal) {
    return res.status(400).json({ error: "Faltan datos para el bloque" });
  }
  
  const numPrograma = datosPaciente.num_programa || 1;

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

        console.log(`🔄 Intentando UPDATE al paciente ${idPacienteFinal}...`);
        
        const sqlUpdatePaciente = `
            UPDATE paciente 
            SET 
              motivo_estudio = $1, 
              servicio = $2,        
              domicilio = $3,       
              telefono = $4,
              edad = $5             
            WHERE id_paciente = $6
        `;
        
        const resUpdate = await client.query(sqlUpdatePaciente, [
            datosPaciente.motivo_estudio, // Asegúrate que en Flutter se llame así
            datosPaciente.servicio,       
            datosPaciente.domicilio,      
            datosPaciente.telefono,       
            datosPaciente.edad,           
            idPacienteFinal               
        ]);
        
        // ¡AQUÍ ESTÁ EL CHIVATO!
        if (resUpdate.rowCount === 0) {
            console.log("⚠️ ALERTA: El UPDATE corrió pero no encontró al paciente (Filas afectadas: 0)");
            throw new Error(`Paciente ID ${idPacienteFinal} no encontrado para actualizar.`);
        } else {
            console.log("✅ UPDATE exitoso. Filas afectadas:", resUpdate.rowCount);
        }

    } else {
        // --- CASO: INSERT PACIENTE ---
        console.log("🆕 Creando paciente nuevo...");
        const sqlInsertPaciente = `
           INSERT INTO paciente (
              nombre, edad, fecha_nac, entidad_fed, curp, domicilio, 
              cp, telefono, sexo, edo_civil, escolaridad, ref_medica, 
              servicio, motivo_estudio, estatus_paciente
           )
           VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9, $10, $11, $12, $13, $14, 'Activo')
           RETURNING id_paciente; 
        `;
        const p = datosPaciente;
        const valores = [p.nombre, p.edad, p.fecha_nac, p.entidad_fed, p.curp, p.domicilio, p.cp, p.telefono, p.sexo, p.edo_civil, p.escolaridad, p.ref_medica, p.servicio, p.motivo_estudio];
        
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
      await client.query(sqlCita, [
        idPacienteFinal, idPersonal, cita.fecha, cita.hora_inicio, cita.hora_fin,
        servicioGuardar, indice, totalVal, numPrograma
      ]);
      indice++;
    }

    await client.query("COMMIT");
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

// Endpoint: Registrar Sesión (Bitácora) - CORREGIDO
// Endpoint: Registrar Sesión (Bitácora) - VERSIÓN INTELIGENTE (P->V)
app.post('/registrar-sesion', async (req, res) => {
  const { id_cita, id_paciente, observaciones, tipo_terapia, estatus_asistencia } = req.body;

  if (!id_cita || !id_paciente || !estatus_asistencia) {
    return res.status(400).json({ error: "Faltan datos obligatorios" });
  }

  try {
    await pool.query('BEGIN');

    // 1. INSERTAR EN HISTORIAL
    const queryHistorial = `
      INSERT INTO historial_consultas 
      (id_cita, id_paciente, observaciones, tipo_terapia, fecha_vencimiento)
      VALUES ($1, $2, $3, $4, NULL) 
    `;
    await pool.query(queryHistorial, [id_cita, id_paciente, observaciones, tipo_terapia]);

    // 2. ACTUALIZAR CITA (AQUÍ ESTÁ LA MAGIA)
    // Usamos CASE: "Si tipo_cita es 'P', cámbialo a 'V'. Si no, déjalo igual."
    const queryUpdateCita = `
      UPDATE citas 
      SET 
        asistencia = $1,     
        estatus = 'Finalizada',
        tipo_cita = CASE WHEN tipo_cita = 'P' THEN 'V' ELSE tipo_cita END
      WHERE id_cita = $2
    `;

    await pool.query(queryUpdateCita, [estatus_asistencia, id_cita]);

    await pool.query('COMMIT');
    res.status(200).json({ message: "Sesión registrada correctamente" });

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
    servicio_area 
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
                        WHEN tipo_cita = 'P' THEN 'V' -- Evoluciona a Valoración
                        ELSE tipo_cita                -- Se mantiene igual (ej. 'A')
                      END
        WHERE id_cita = $2
      `;
      await pool.query(updateOrigenQuery, [asistencia_origen, id_cita_origen]);
    }

    // ---------------------------------------------------------
    // 2. LÓGICA DE SERVICIO Y ÁREA
    // ---------------------------------------------------------
    let numProgramaBase = 1;
    let servicioOriginal = 'General';

    // Recuperar datos de la cita origen para mantener continuidad
    if (id_cita_origen) {
      const origenRes = await pool.query(
        'SELECT num_programa, servicio_area FROM citas WHERE id_cita = $1', 
        [id_cita_origen]
      );
      if (origenRes.rows.length > 0) {
        numProgramaBase = origenRes.rows[0].num_programa || 1;
        servicioOriginal = origenRes.rows[0].servicio_area || 'General';
      }
    }

    // Prioridad de Asignación: 1. Input Front -> 2. Cita Anterior -> 3. Especialidad Dr.
    let servicioFinal = servicio_area || servicioOriginal;

    if (!servicioFinal || servicioFinal === 'null') {
       const personalRes = await pool.query(
         'SELECT funcion FROM personal WHERE id_personal = $1', 
         [id_personal]
       );
       servicioFinal = personalRes.rows.length > 0 ? personalRes.rows[0].funcion : 'General';
    }

    // ---------------------------------------------------------
    // 3. ACTUALIZAR PERFIL DEL PACIENTE (Nueva Lógica)
    // ---------------------------------------------------------
    // Actualizamos el servicio en el perfil del paciente para consistencia futura
    if (servicioFinal && servicioFinal !== 'General') {
       await pool.query(
         "UPDATE paciente SET servicio = $1 WHERE id_paciente = $2",
         [servicioFinal, id_paciente]
       );
       // console.log(`Pac. actualizado a: ${servicioFinal}`); // Descomentar para debug
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
      
      // Lógica de conteo:
      // 'P' (Programada/Valoración) = Conteo normal (1 de 3, 2 de 3...)
      // 'A' (Tratamiento/Agenda)    = Siempre 1 de 1
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
        numProgramaBase, 
        indiceParaGuardar, 
        totalParaGuardar
      ]);
    }

    await pool.query('COMMIT');
    
    // Respuesta exitosa
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
// --- RUTA: PACIENTES BAJA/ALTA (NUEVA) ---
// -----------------------------------------------------------
app.get("/pacientes-bajas-altas", async (req, res) => {
  const { tipo } = req.query; // 'BAJA' o 'ALTA'
  const client = await pool.connect();

  try {
    // 1. Filtro base según lo que pida el admin
    let filtroEstatus = "";
    if (tipo === 'BAJA') {
      filtroEstatus = "p.estatus_paciente = 'Baja'";
    } else {
      filtroEstatus = "p.estatus_paciente IN ('Alta', 'Finalizado')";
    }

    const sql = `
      SELECT 
        p.*,
        -- Datos de citas para el historial
        c.id_cita, c.fecha, c.hora_inicio, c.asistencia, c.servicio_area,
        per.nombre as nombre_tratante,
        hc.observaciones
      FROM paciente p
      LEFT JOIN citas c ON p.id_paciente = c.id_paciente
      LEFT JOIN personal per ON c.id_personal = per.id_personal
      LEFT JOIN historial_consultas hc ON c.id_cita = hc.id_cita
      
      WHERE ${filtroEstatus}
      
      ORDER BY p.nombre ASC, c.fecha DESC
    `;

    const result = await client.query(sql);

    // 2. Agrupamos los datos (El mismo truco del Map)
    const pacientesMap = {};

    result.rows.forEach(row => {
      if (!pacientesMap[row.id_paciente]) {
        pacientesMap[row.id_paciente] = {
          id_paciente: row.id_paciente,
          nombre: row.nombre,
          servicio: row.servicio,
          telefono: row.telefono,
          estatus_paciente: row.estatus_paciente,
          historial: [] // Iniciamos lista vacía
        };
      }

      // Si tiene citas, las agregamos al historial
      if (row.id_cita) {
        pacientesMap[row.id_paciente].historial.push({
          id_cita: row.id_cita,
          fecha: row.fecha,
          hora: row.hora_inicio,
          asistencia: row.asistencia,
          tratante: row.nombre_tratante,
          observacion: row.observaciones,
          servicio_area: row.servicio_area
        });
      }
    });

    // 3. Calculamos contadores rápidos para mostrarlos en la tarjeta
    const listaFinal = Object.values(pacientesMap).map(p => {
        // Contamos incidencias
        p.cant_faltas = p.historial.filter(c => [1,2,3].includes(c.asistencia)).length;
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


app.get("/pacientes-pendientes-entrevista", async (req, res) => {
  // 1. Ahora recibimos también 'area' (o 'especialidad' según como lo mandes desde Flutter)
  const { fecha, area } = req.query; 

  if (!fecha) {
    return res.status(400).json({ error: "Falta el parámetro 'fecha'" });
  }

  const client = await pool.connect();
  try {
    console.log(`\n--- 🕵️‍♂️ BUSCANDO PENDIENTES: Fecha: ${fecha}, Area: ${area || 'Todas'} ---`);

    // 2. Preparamos el filtro dinámico para el Área
    let filtroAreaSQL = "";
    const queryParams = [fecha]; // Array de parámetros, empieza solo con fecha ($1)

    if (area && area !== "Todas") {
      // Si mandan área, agregamos la condición AND. 
      // NOTA: Asegúrate que en tu BD 'pe.funcion' coincida con 'Psicologia', 'Fisica', etc.
      // Usamos ILIKE para ignorar mayúsculas/minúsculas por si acaso.
      filtroAreaSQL = "AND pe.funcion ILIKE $2"; 
      queryParams.push(area); // Agregamos el valor al array ($2)
    }

const sqlPacientes = `
      SELECT 
        p.edad,
        p.fecha_nac,  -- Alias para que coincida con tu Flutter
        p.sexo,
        
        
        p.edo_civil,
        p.escolaridad,
        p.ocupacion,
        p.entidad_fed,
        p.cp,
        p.motivo_estudio,
        p.servicio,
        p.num_consultorio,

        p.id_paciente,
        p.nombre,
        p.tel_domicilio,
        p.telefono,
        c.id_cita,
        c.num_programa,
        c.indice_val,
        c.total_val,
        TO_CHAR(c.hora_inicio, 'HH24:MI') as hora_inicio_cita,
        TO_CHAR(c.hora_fin, 'HH24:MI') as hora_fin_cita,
        pe.nombre as nombre_terapeuta,
        pe.funcion as especialidad
      FROM citas c
      JOIN paciente p ON c.id_paciente = p.id_paciente
      LEFT JOIN personal pe ON c.id_personal = pe.id_personal
      WHERE c.fecha = $1
      
      ${filtroAreaSQL} 
      
      AND (p.fecha_estudios IS NULL)    
      AND p.estatus_paciente = 'Activo' 

      -- 🛡️ FILTRO 1: REFERENCIAS (Este SÍ lo dejamos)
      -- Evita que te salga un paciente en Psicología si ya lo movieron a Terapia Física.
      AND unaccent(TRIM(c.servicio_area)) ILIKE unaccent(TRIM(p.servicio))

      -- 🔓 FILTRO 2: ELIMINADO
      -- Dejamos pasar los "3 de 5" para que tú decidas en la pantalla.

      ORDER BY c.hora_inicio ASC;
    `;

    // 3. Ejecutamos la query pasando los parámetros dinámicos
    const resPacientes = await client.query(sqlPacientes, queryParams);
    const listaPacientes = resPacientes.rows;

    // 4. Buscar próximas citas (esto se queda igual)
    const resultadoFinal = await Promise.all(listaPacientes.map(async (paciente) => {
      const sqlProximas = `
        SELECT 
          c.fecha,
          TO_CHAR(c.hora_inicio, 'HH24:MI') as hora_inicio,
          TO_CHAR(c.hora_fin, 'HH24:MI') as hora_fin
        FROM citas c
        WHERE c.id_paciente = $1
        AND c.fecha >= $2 
        ORDER BY c.fecha ASC
        LIMIT 4;
      `;
      // Ojo: Aquí usamos los parámetros específicos para esta sub-query, no el array queryParams global
      const resProximas = await client.query(sqlProximas, [paciente.id_paciente, fecha]);
      
      return {
        ...paciente,
        proximas_citas: resProximas.rows
      };
    }));

    res.json(resultadoFinal);

  } catch (error) {
    console.error("🔥 Error en /pacientes-pendientes-entrevista:", error);
    res.status(500).json({ error: "Error al buscar pendientes" });
  } finally {
    client.release();
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

// 🔍 OBTENER PACIENTES PENDIENTES DE CITA
// Busca pacientes en la tabla 'pacientes' que NO aparecen en la tabla 'citas'
app.get("/pacientes/pendientes-cita", async (req, res) => {
  try {
    const query = `
      SELECT 
        p.id_paciente, 
        p.nombre, 
        p.curp, 
        p.telefono, 
        p.servicio,
        p.fecha_registro -- Esta ya funcionará tras el ALTER TABLE
      FROM paciente p
      LEFT JOIN citas c ON p.id_paciente = c.id_paciente
      WHERE c.id_paciente IS NULL
      ORDER BY p.fecha_registro DESC;
    `;
    
    const result = await pool.query(query);
    res.json(result.rows);
  } catch (err) {
    console.error("Error en /pacientes/pendientes-cita:", err);
    res.status(500).json({ error: "Error interno del servidor" });
  }
});;

// 🚀 NUEVO SERVICIO: Guardar paciente solo (sin cita aún)
app.post("/pacientes", async (req, res) => {
  try {
    // 1. Extraemos los 14 campos que manda Flutter
    const { 
      nombre, edad, fecha_nac, entidad_fed, curp, 
      telefono, domicilio, cp, sexo, edo_civil, 
      escolaridad, ref_medica, servicio, motivo_estudio 
    } = req.body;

    // 2. Ajustamos la consulta con 14 columnas y 14 símbolos de $
    const query = `
      INSERT INTO paciente (
        nombre, edad, fecha_nac, entidad_fed, curp, 
        telefono, domicilio, cp, sexo, edo_civil, 
        escolaridad, ref_medica, servicio, motivo_estudio, fecha_registro
      ) 
      VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9, $10, $11, $12, $13, $14, NOW())
      RETURNING *;
    `;

    const values = [
      nombre, edad, fecha_nac, entidad_fed, curp, 
      telefono, domicilio, cp, sexo, edo_civil, 
      escolaridad, ref_medica, servicio, motivo_estudio
    ];

    const result = await pool.query(query, values);
    res.status(201).json(result.rows[0]);
  } catch (err) {
    console.error("Error al registrar:", err);
    res.status(500).json({ error: "Error en el servidor" });
  }
});

///////////////////////////////////////////
// INICIO DEL SERVIDOR (Correcto)
// ---------------------------
app.listen(PORT, '0.0.0.0', () => {
  console.log(`🚀 Servidor corriendo en http://localhost:${PORT} (y accesible en tu red)`);

});


















