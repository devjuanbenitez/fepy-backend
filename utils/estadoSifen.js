/**
 * Utilitarios para manejo de estados SIFEN v150
 * 
 * Este módulo centraliza la lógica de determinación de estados
 * y extracción de datos de respuestas SOAP de la SET.
 * Soporta respuestas en formato String (XML) y Object (JSON).
 */

/**
 * Función auxiliar para navegar el objeto JSON y extraer valores de forma segura
 * SIFEN usa nombres de campos con prefijos (ej: ns2:dCodRes)
 */
function buscarEnObjeto(obj, campo) {
  if (!obj || typeof obj !== 'object') return null;

  // 1. Buscar directamente o con prefijo ns2:
  const valor = obj[campo] || obj[`ns2:${campo}`] || obj[`ns: ${campo}`];
  if (valor !== undefined) {
    if (Array.isArray(valor)) return valor[0];
    return valor;
  }

  // 2. Búsqueda recursiva en profundidad para encontrar el primer match
  for (const key in obj) {
    if (typeof obj[key] === 'object') {
      const resultadoRescursivo = buscarEnObjeto(obj[key], campo);
      if (resultadoRescursivo !== null) return resultadoRescursivo;
    }
  }

  return null;
}

/**
 * Extrae el código de retorno de una respuesta SOAP
 * Soporta: <ns2:dCodRes>, <dCodRes>, <codigoRetorno>
 */
function extraerCodigoRetorno(content) {
  if (!content) return null;

  // Caso Objeto (JSON parsed)
  if (typeof content === 'object') {
    return buscarEnObjeto(content, 'dCodRes') || buscarEnObjeto(content, 'codigoRetorno');
  }

  // Caso String (XML raw)
  try {
    const match =
      content.match(/<ns2:dCodRes>(.*?)<\/ns2:dCodRes>/) ||
      content.match(/<dCodRes>(.*?)<\/dCodRes>/) ||
      content.match(/<codigoRetorno>(.*?)<\/codigoRetorno>/);

    return (match && match[1]) ? match[1].trim() : null;
  } catch (error) {
    console.warn('⚠️ Error al extraer código de retorno:', error.message);
    return null;
  }
}

/**
 * Extrae el mensaje de retorno de una respuesta SOAP
 */
function extraerMensajeRetorno(content) {
  if (!content) return null;

  if (typeof content === 'object') {
    return buscarEnObjeto(content, 'dMsgRes') || buscarEnObjeto(content, 'mensajeRetorno');
  }

  try {
    const match =
      content.match(/<ns2:dMsgRes>(.*?)<\/ns2:dMsgRes>/) ||
      content.match(/<dMsgRes>(.*?)<\/dMsgRes>/) ||
      content.match(/<mensajeRetorno>(.*?)<\/mensajeRetorno>/);

    return (match && match[1]) ? match[1].trim() : null;
  } catch (error) {
    console.warn('⚠️ Error al extraer mensaje de retorno:', error.message);
    return null;
  }
}

/**
 * Extrae el estado de resultado de una respuesta SOAP
 */
function extraerEstadoResultado(content) {
  if (!content) return null;

  if (typeof content === 'object') {
    return buscarEnObjeto(content, 'dEstRes') || buscarEnObjeto(content, 'estadoResultado');
  }

  try {
    const match =
      content.match(/<ns2:dEstRes>(.*?)<\/ns2:dEstRes>/) ||
      content.match(/<dEstRes>(.*?)<\/dEstRes>/) ||
      content.match(/<estadoResultado>(.*?)<\/estadoResultado>/);

    return (match && match[1]) ? match[1].trim() : null;
  } catch (error) {
    console.warn('⚠️ Error al extraer estado de resultado:', error.message);
    return null;
  }
}

/**
 * Extrae el CDC de una respuesta SOAP
 */
function extraerCDC(content) {
  if (!content) return null;

  if (typeof content === 'object') {
    return buscarEnObjeto(content, 'idEvento') || buscarEnObjeto(content, 'id') || buscarEnObjeto(content, 'cdc');
  }

  try {
    const match =
      content.match(/<ns2:idEvento>(.*?)<\/ns2:idEvento>/) ||
      content.match(/<idEvento>(.*?)<\/idEvento>/) ||
      content.match(/<ns2:id>(.*?)<\/ns2:id>/) ||
      content.match(/<id>(.*?)<\/id>/) ||
      content.match(/<cdc>(.*?)<\/cdc>/);

    return (match && match[1]) ? match[1].trim() : null;
  } catch (error) {
    console.warn('⚠️ Error al extraer CDC:', error.message);
    return null;
  }
}

/**
 * Extrae la fecha de proceso de una respuesta SOAP
 */
function extraerFechaProceso(content) {
  if (!content) return null;

  if (typeof content === 'object') {
    return buscarEnObjeto(content, 'dFecProc') || buscarEnObjeto(content, 'fechaProceso');
  }

  try {
    const match =
      content.match(/<ns2:dFecProc>(.*?)<\/ns2:dFecProc>/) ||
      content.match(/<dFecProc>(.*?)<\/dFecProc>/) ||
      content.match(/<fechaProceso>(.*?)<\/fechaProceso>/);

    return (match && match[1]) ? match[1].trim() : null;
  } catch (error) {
    console.warn('⚠️ Error al extraer fecha de proceso:', error.message);
    return null;
  }
}

/**
 * Extrae el DigestValue de una respuesta SOAP
 */
function extraerDigestValue(content) {
  if (!content) return null;

  if (typeof content === 'object') {
    return buscarEnObjeto(content, 'dDigVal') || buscarEnObjeto(content, 'digestValue');
  }

  try {
    const match =
      content.match(/<ns2:dDigVal>(.*?)<\/ns2:dDigVal>/) ||
      content.match(/<dDigVal>(.*?)<\/dDigVal>/) ||
      content.match(/<digestValue>(.*?)<\/digestValue>/);

    return (match && match[1]) ? match[1].trim() : null;
  } catch (error) {
    console.warn('⚠️ Error al extraer DigestValue:', error.message);
    return null;
  }
}

/**
 * Verifica si dentro del contenido (como xContenDE) existe un evento de cancelación aprobado
 */
function contieneEventoCancelacion(content) {
  if (!content) return false;
  
  const contentStr = typeof content === 'object' ? JSON.stringify(content) : content;
  
  // rGeVeCan es el elemento XML que marca un evento de cancelación
  return contentStr.includes('<rGeVeCan>') || contentStr.includes('&lt;rGeVeCan&gt;');
}

/**
 * Determina el estado SIFEN según el código de retorno
 */
function determinarEstadoSegunCodigo(codigo) {
  if (!codigo) return 'rechazado';

  // 0260 = Éxito / Autorización Satisfactoria
  // 0422 = CDC Encontrado (Consulta)
  if (['0260', '0', '2', '0422'].includes(codigo)) {
    return 'aceptado';
  }

  // 1005 = Transmisión extemporánea (Observado)
  if (codigo === '1005') {
    return 'observado';
  }

  // Errores de comunicación o estructura (No son estado final real del DE)
  // 0160: XML Mal Formado
  // 0161: Firma del DE inválida o corrompida
  if (['0160', '0161'].includes(codigo)) {
    return 'procesando'; // Mantiene la factura pendiente de reintento/consulta
  }

  // Cualquier otro código es considerado rechazado o error
  return 'rechazado';
}

/**
 * Determina el estado visual
 */
function determinarEstadoVisual(codigo) {
  // Para errores de estructura que dejamos en 'procesando',
  // queremos que visualmente se note que hubo un error (rechazado/error)
  if (['0160', '0161'].includes(codigo)) {
    return 'rechazado';
  }
  
  const estadoSifen = determinarEstadoSegunCodigo(codigo);
  return estadoSifen; // Coinciden en este sistema
}

/**
 * Obtiene el color de Vuetify para el estado visual
 */
function getColorPorEstadoVisual(estadoVisual) {
  switch (estadoVisual) {
    case 'aceptado': return 'success';
    case 'observado': return 'amber';
    case 'rechazado': return 'error';
    default: return 'info';
  }
}

/**
 * Obtiene el mensaje descriptivo según el código de retorno
 */
function getMensajePorCodigo(codigo) {
  const mensajes = {
    '0260': 'Autorización del DE satisfactoria',
    '1005': 'Transmisión extemporánea del DE',
    '0160': 'XML Mal Formado o Error de Estructura SOAP',
    '0161': 'Firma del DE inválida o corrompida',
    '1000': 'CDC no corresponde con las informaciones del XML',
    '1001': 'CDC duplicado',
    '1002': 'Documento electrónico duplicado',
    '1003': 'DV del CDC inválido',
    '1004': 'La fecha y hora de la firma digital es adelantada',
    '0420': 'CDC inexistente - Documento no encontrado en la SET',
    '0422': 'CDC encontrado',
    '0': 'Procesamiento exitoso',
    '2': 'Documento aprobado',
    '1': 'Documento rechazado'
  };

  return mensajes[codigo] || `Error SIFEN (Código: ${codigo})`;
}

/**
 * Extrae el estado del documento de una respuesta de consulta
 */
/**
 * Extrae el estado del documento de una respuesta de consulta
 */
function extraerEstadoDocumento(content) {
  if (!content) return null;

  if (typeof content === 'object') {
    return buscarEnObjeto(content, 'estado') || buscarEnObjeto(content, 'estadoResultado');
  }

  try {
    const match =
      content.match(/<ns2:estado>(.*?)<\/ns2:estado>/) ||
      content.match(/<estado>(.*?)<\/estado>/) ||
      content.match(/<estadoResultado>(.*?)<\/estadoResultado>/);

    return (match && match[1]) ? match[1].trim() : null;
  } catch (error) {
    console.warn('⚠️ Error al extraer estado del documento:', error.message);
    return null;
  }
}

/**
 * Extrae el protocolo de consulta de un lote (dProtConsLote)
 */
function extraerProtocoloLote(content) {
  if (!content) return null;
  if (typeof content === 'object') {
    return buscarEnObjeto(content, 'dProtConsLote') || buscarEnObjeto(content, 'numeroLote');
  }
  return null; // Por ahora no implementamos regex para esto en XML ya que suele venir en el objeto de respuesta
}

/**
 * Extrae el código de resultado del procesamiento del lote (dCodResLot)
 */
function extraerCodigoLote(content) {
  if (!content) return null;
  if (typeof content === 'object') {
    return buscarEnObjeto(content, 'dCodResLot');
  }
  return null;
}

/**
 * Extrae la lista de resultados de documentos en el lote (gResProcLote)
 */
function extraerResultadosLote(content) {
  if (!content || typeof content !== 'object') return null;
  
  // Buscar recursivamente para no perder el Array que buscarEnObjeto destruiría.
  function buscarArray(obj, campo) {
    if (!obj || typeof obj !== 'object') return null;
    const valor = obj[campo] || obj[`ns2:${campo}`] || obj[`ns: ${campo}`];
    if (valor !== undefined) return valor; // Retornar tal cual (Array preservado)
    for (const key in obj) {
      if (typeof obj[key] === 'object') {
        const res = buscarArray(obj[key], campo);
        if (res !== null) return res;
      }
    }
    return null;
  }
  
  return buscarArray(content, 'gResProcLote');
}

module.exports = {
  buscarEnObjeto,
  extraerCodigoRetorno,
  extraerMensajeRetorno,
  extraerEstadoResultado,
  extraerEstadoDocumento,
  extraerCDC,
  extraerFechaProceso,
  extraerDigestValue,
  extraerProtocoloLote,
  extraerCodigoLote,
  extraerResultadosLote,
  determinarEstadoSegunCodigo,
  determinarEstadoVisual,
  getColorPorEstadoVisual,
  getMensajePorCodigo,
  contieneEventoCancelacion
};
