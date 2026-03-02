/**
 * Utilitarios para manejo de estados SIFEN v150
 * 
 * Este módulo centraliza la lógica de determinación de estados
 * y extracción de datos de respuestas SOAP de la SET.
 */

/**
 * Extrae el código de retorno de una respuesta SOAP
 * Soporta ambos formatos: <codigoRetorno> y <dCodRes>
 * 
 * @param {string} xmlContent - Contenido XML de la respuesta SOAP
 * @returns {string|null} Código de retorno o null si no encuentra
 */
function extraerCodigoRetorno(xmlContent) {
  try {
    // Soporta ambos formatos: SIFEN v150 (dCodRes) y genérico
    const match = 
      xmlContent.match(/<dCodRes>(.*?)<\/dCodRes>/) ||
      xmlContent.match(/<codigoRetorno>(.*?)<\/codigoRetorno>/);
    
    if (match && match[1]) {
      return match[1].trim();
    }
    return null;
  } catch (error) {
    console.warn('⚠️ Error al extraer código de retorno:', error.message);
    return null;
  }
}

/**
 * Extrae el mensaje de retorno de una respuesta SOAP
 * Soporta ambos formatos: <mensajeRetorno> y <dMsgRes>
 * 
 * @param {string} xmlContent - Contenido XML de la respuesta SOAP
 * @returns {string|null} Mensaje de retorno o null si no encuentra
 */
function extraerMensajeRetorno(xmlContent) {
  try {
    // Soporta ambos formatos: SIFEN v150 (dMsgRes) y genérico
    const match = 
      xmlContent.match(/<dMsgRes>(.*?)<\/dMsgRes>/) ||
      xmlContent.match(/<mensajeRetorno>(.*?)<\/mensajeRetorno>/);
    
    if (match && match[1]) {
      return match[1].trim();
    }
    return null;
  } catch (error) {
    console.warn('⚠️ Error al extraer mensaje de retorno:', error.message);
    return null;
  }
}

/**
 * Extrae el estado de resultado de una respuesta SOAP
 * Soporta ambos formatos: <estadoResultado> y <dEstRes>
 * 
 * @param {string} xmlContent - Contenido XML de la respuesta SOAP
 * @returns {string|null} Estado de resultado o null si no encuentra
 */
function extraerEstadoResultado(xmlContent) {
  try {
    // Soporta ambos formatos: SIFEN v150 (dEstRes) y genérico
    const match = 
      xmlContent.match(/<dEstRes>(.*?)<\/dEstRes>/) ||
      xmlContent.match(/<estadoResultado>(.*?)<\/estadoResultado>/);
    
    if (match && match[1]) {
      return match[1].trim();
    }
    return null;
  } catch (error) {
    console.warn('⚠️ Error al extraer estado de resultado:', error.message);
    return null;
  }
}

/**
 * Extrae el CDC de una respuesta SOAP
 * 
 * @param {string} xmlContent - Contenido XML de la respuesta SOAP
 * @returns {string|null} CDC o null si no encuentra
 */
function extraerCDC(xmlContent) {
  try {
    const match = xmlContent.match(/<cdc>(.*?)<\/cdc>/);
    if (match && match[1]) {
      return match[1].trim();
    }
    return null;
  } catch (error) {
    return null;
  }
}

/**
 * Extrae la fecha de proceso de una respuesta SOAP
 * Soporta ambos formatos: <fechaProceso> y <dFecProc>
 * 
 * @param {string} xmlContent - Contenido XML de la respuesta SOAP
 * @returns {string|null} Fecha de proceso o null si no encuentra
 */
function extraerFechaProceso(xmlContent) {
  try {
    const match = 
      xmlContent.match(/<dFecProc>(.*?)<\/dFecProc>/) ||
      xmlContent.match(/<fechaProceso>(.*?)<\/fechaProceso>/);
    
    if (match && match[1]) {
      return match[1].trim();
    }
    return null;
  } catch (error) {
    return null;
  }
}

/**
 * Extrae el DigestValue de una respuesta SOAP
 * Soporta ambos formatos: <digestValue> y <dDigVal>
 * 
 * @param {string} xmlContent - Contenido XML de la respuesta SOAP
 * @returns {string|null} DigestValue o null si no encuentra
 */
function extraerDigestValue(xmlContent) {
  try {
    const match = 
      xmlContent.match(/<dDigVal>(.*?)<\/dDigVal>/) ||
      xmlContent.match(/<digestValue>(.*?)<\/digestValue>/);
    
    if (match && match[1]) {
      return match[1].trim();
    }
    return null;
  } catch (error) {
    return null;
  }
}

/**
 * Determina el estado SIFEN según el código de retorno
 * Para sistema síncrono simplificado:
 *
 * Códigos de recepción síncrona (siRecepDE) según Manual Técnico v150:
 * - 0260 = Autorización del DE satisfactoria (Aprobado - DTE) 🟢
 * - 1005 = Transmisión extemporánea (Observado) 🟠
 * - 0000 = En procesamiento (Pendiente de aprobación) 🟠
 * - 1000-1004 = Errores de validación (Rechazado) 🔴
 * - 0420 = CDC inexistente (Rechazado) 🔴
 *
 * Códigos de consulta (consDE):
 * - 0421 = CDC encontrado (éxito de consulta, estado real en <estado>)
 * - 0420 = CDC inexistente (error de consulta)
 *
 * NOTA: El estado "observado" solo se usa para código 1005 (transmisión extemporánea).
 * Para código 0000, el estado es "enviado" pero el estadoVisual es "observado" (amber).
 *
 * @param {string} codigo - Código de retorno de 4 dígitos
 * @returns {string} Estado determinado: 'aceptado', 'enviado', 'observado', 'procesando', 'rechazado'
 */
function determinarEstadoSegunCodigo(codigo) {
  if (!codigo) return 'enviado';

  // Éxito - Autorización satisfactoria (SIFEN v150) - códigos legacy 0, 2
  if (['0260', '0', '2'].includes(codigo)) {
    return 'aceptado';
  }

  // Transmisión extemporánea - Observado (único caso donde estado = 'observado')
  if (codigo === '1005') {
    return 'observado';
  }

  // Código de procesamiento inicial (mock-set) - Enviado
  if (codigo === '0000') {
    return 'enviado';
  }

  // 0421 = CDC encontrado en consulta - el estado real está en <estado>
  // Por defecto retornamos 'procesando' hasta verificar el campo <estado>
  if (codigo === '0421') {
    return 'procesando';
  }

  // Pendiente de procesamiento
  if (['3', '0003'].includes(codigo)) {
    return 'procesando';
  }

  // Rechazado - códigos específicos (Manual Técnico v150)
  if (['1000', '1001', '1002', '1003', '1004', '1'].includes(codigo)) {
    return 'rechazado';
  }

  // Inexistente (CDC no encontrado en SET)
  if (codigo === '0420') {
    return 'rechazado';
  }

  return 'enviado';
}

/**
 * Determina el estado visual según el código de retorno
 * El estado visual se usa para mostrar colores en el frontend
 *
 * Nota: Para consultas (código 0421), el estado real del documento
 * debe evaluarse usando el campo <estado> de la respuesta SOAP,
 * no solo el código de retorno. Esta función asume estado 'observado'
 * para 0421 por defecto.
 *
 * @param {string} codigo - Código de retorno de 4 dígitos
 * @returns {string} Estado visual: 'aceptado', 'observado', 'rechazado'
 */
function determinarEstadoVisual(codigo) {
  if (!codigo) return 'rechazado';

  // 0260 = Verde (Aceptado - Autorización satisfactoria)
  if (codigo === '0260') {
    return 'aceptado';
  }

  // 1005 = Amarillo (Observado - Transmisión extemporánea)
  if (codigo === '1005') {
    return 'observado';
  }

  // 0000 = Amarillo (En procesamiento / Pendiente de aprobación)
  if (codigo === '0000') {
    return 'observado';
  }

  // 0421 = Amarillo (CDC encontrado en consulta - estado por defecto)
  // El estado real depende del campo <estado>: Aprobado/Rechazado/Pendiente
  if (codigo === '0421') {
    return 'observado';  // Por defecto, se asume pendiente hasta verificar <estado>
  }

  // 0, 2 = Verde (Códigos legacy de éxito)
  if (['0', '2'].includes(codigo)) {
    return 'aceptado';
  }

  // Otros = Rojo (Rechazado)
  return 'rechazado';
}

/**
 * Obtiene el color de Vuetify para el estado visual
 *
 * @param {string} estadoVisual - Estado visual: 'aceptado', 'observado', 'rechazado'
 * @returns {string} Color de Vuetify: 'success', 'amber', 'error'
 */
function getColorPorEstadoVisual(estadoVisual) {
  switch (estadoVisual) {
    case 'aceptado':
      return 'success';  // Verde
    case 'observado':
      return 'amber';    // Amarillo medio oscuro
    case 'rechazado':
      return 'error';    // Rojo
    default:
      return 'info';
  }
}

/**
 * Obtiene el mensaje descriptivo según el código de retorno
 * 
 * @param {string} codigo - Código de retorno de 4 dígitos
 * @returns {string} Mensaje descriptivo
 */
function getMensajePorCodigo(codigo) {
  const mensajes = {
    '0260': 'Autorización del DE satisfactoria',
    '1005': 'Transmisión extemporánea del DE',
    '0000': 'DE recibido correctamente, en procesamiento',
    '1000': 'CDC no corresponde con las informaciones del XML',
    '1001': 'CDC duplicado',
    '1002': 'Documento electrónico duplicado',
    '1003': 'DV del CDC inválido',
    '1004': 'La fecha y hora de la firma digital es adelantada',
    '0420': 'CDC inexistente - Documento no encontrado en la SET',
    '0421': 'CDC encontrado',
    '0': 'Procesamiento exitoso',
    '2': 'Documento aprobado',
    '3': 'Documento en procesamiento',
    '1': 'Documento rechazado'
  };

  return mensajes[codigo] || 'Estado desconocido';
}

module.exports = {
  // Funciones de extracción de SOAP
  extraerCodigoRetorno,
  extraerMensajeRetorno,
  extraerEstadoResultado,
  extraerCDC,
  extraerFechaProceso,
  extraerDigestValue,
  
  // Funciones de determinación de estados
  determinarEstadoSegunCodigo,
  determinarEstadoVisual,
  getColorPorEstadoVisual,
  getMensajePorCodigo
};
