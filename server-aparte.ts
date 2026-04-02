import express, { Request, Response } from 'express';
import xmlgen from 'facturacionelectronicapy-xmlgen';
import xmlsign from 'facturacionelectronicapy-xmlsign';
import qrgen from 'facturacionelectronicapy-qrgen';
import setApi from 'facturacionelectronicapy-setapi';
import path from 'path'
import dotenv from 'dotenv';
import fs from 'fs';

// load .env
dotenv.config();

const app = express();
app.use(express.json());
app.use(express.urlencoded({ extended: true }));

const AMBIENTE_SET = process.env.AMBIENTE_SET as "test" | "prod";

/**
 * Obtiene la ruta del certificado y el password desde los headers o valores por defecto.
 */
function getCertInfo(req: Request) {
  const ruc = (req.headers['x-ruc'] || req.headers['ruc']) as string;
  const password = (req.headers['x-password'] || req.headers['password']) as string;

  if (!ruc || !password) {
    return null;
  }

  const certPath = path.resolve(__dirname, '../cert', `${ruc}.p12`);

  return { certPath, password, ruc };
}

/**
 * Genera el XML de un Documento Electrónico (DE).
 */
app.post('/generar-xml', async (req: Request, res: Response) => {
  try {
    const { params, data } = req.body;

    if (!params) return res.status(400).json({ error: 'params es requerido' });
    if (!data) return res.status(400).json({ error: 'data es requerido' });

    const xml = await xmlgen.generateXMLDE(params, data);
    return res.status(200).send(xml);
  } catch (err: any) {
    console.error('Error generando XML:', err);
    return res.status(500).json({ error: err?.message ?? String(err) });
  }
});

/**
 * Firma un XML DE utilizando el certificado digital correspondiente al RUC.
 */
app.post('/firmar-xml', express.text({ type: '*/*', limit: '5mb' }), async (req: Request, res: Response) => {
  try {
    const xml = req.body as string;
    if (!xml || typeof xml !== 'string' || xml.trim() === '') {
      return res.status(400).json({ error: 'xml es requerido en el body' });
    }

    const certInfo = getCertInfo(req);
    if (!certInfo) {
      return res.status(400).json({ error: 'x-ruc y x-password headers son requeridos en el header' });
    }
    const { certPath, password, ruc } = certInfo;

    if (!fs.existsSync(certPath)) {
      return res.status(404).json({ error: 'Certificado pkcs12 no encontrado' });
    }
    console.log(`Firmando XML para RUC: ${ruc} usando: ${certPath}`);

    const xmlsigned = await xmlsign.signXML(xml, certPath, password, true);
    return res.status(200).send(xmlsigned);
  } catch (err: any) {
    console.error('Error firmando XML:', err);
    return res.status(500).json({ error: err?.message ?? String(err) });
  }
});

/**
 * Firma un XML de Evento utilizando el certificado digital correspondiente al RUC.
 */
app.post('/firmar-evento', express.text({ type: '*/*', limit: '5mb' }), async (req: Request, res: Response) => {
  try {
    const xml = req.body as string;
    if (!xml || typeof xml !== 'string' || xml.trim() === '') {
      return res.status(400).json({ error: 'xml es requerido en el body' });
    }

    const certInfo = getCertInfo(req);
    if (!certInfo) {
      return res.status(400).json({ error: 'x-ruc y x-password headers son requeridos en el header' });
    }
    const { certPath, password, ruc } = certInfo;

    if (!fs.existsSync(certPath)) {
      return res.status(404).json({ error: 'Certificado pkcs12 no encontrado' });
    }
    console.log(`Firmando Evento para RUC: ${ruc} usando: ${certPath}`);

    const xmlsigned = await xmlsign.signXMLEvento(xml, certPath, password, true);
    return res.status(200).send(xmlsigned);
  } catch (err: any) {
    console.error('Error firmando evento:', err);
    return res.status(500).json({ error: err?.message ?? String(err) });
  }
});

/**
 * Genera el código QR para un XML firmado y lo inserta en el mismo.
 */
app.post('/generar-qr', express.text({ type: '*/*', limit: '5mb' }), async (req: Request, res: Response) => {
  try {
    const xmlSigned = req.body as string;
    if (!xmlSigned || typeof xmlSigned !== 'string' || xmlSigned.trim() === '') {
      return res.status(400).json({ error: 'XML firmado es requerido en el body' });
    }

    const idCSC = req.headers['x-idcsc'] as string;
    const CSC = req.headers['x-csc'] as string;

    if (!idCSC || !CSC) {
      return res.status(400).json({ error: 'x-idcsc y x-csc son requeridos en el header' });
    }
    const ambienteParam = AMBIENTE_SET;

    const xmlWithQr = await qrgen.generateQR(xmlSigned, idCSC, CSC, ambienteParam);
    res.set('Content-Type', 'application/xml; charset=utf-8');
    return res.status(200).send(xmlWithQr);
  } catch (err: any) {
    console.error('Error generando QR:', err);
    return res.status(500).json({ error: err?.message ?? String(err) });
  }
});

// ============ ENDPOINTS SET API ============

/**
 * Envía un lote de Documentos Electrónicos a la SET.
 */
app.post('/recibe-lote', express.text({ type: '*/*', limit: '10mb' }), async (req: Request, res: Response) => {
  try {
    const raw = req.body as string;
    let parts = raw.split('<?xml version="1.0" standalone="yes"?>');
    const xmlArray = parts
      .map(p => p.trim())
      .filter(p => p.length > 0)
      .map(p => `<?xml version="1.0" standalone="yes"?>\n${p}`);

    const idParam = req.query.id ? parseInt(req.query.id as string) : Date.now();
    const env = AMBIENTE_SET;

    const certInfo = getCertInfo(req);
    if (!certInfo) {
      return res.status(400).json({ error: 'x-ruc y x-password son requeridos en el header' });
    }
    const { certPath, password, ruc } = certInfo;

    if (!fs.existsSync(certPath)) {
      return res.status(404).json({ error: 'Certificado pkcs12 no encontrado' });
    }
    let config = { debug: false, timeout: 90000 };

    console.log(`Invocando recibeLote RUC: ${ruc}, env: ${env}`);
    const response = await setApi.recibeLote(idParam, xmlArray, env, certPath, password, config);

    return res.status(200).json({ id: idParam, numeroLote: response?.numeroLote, response });
  } catch (err: any) {
    console.error('Error recibeLote:', err);
    return res.status(500).json({ error: err?.message ?? String(err) });
  }
});

/**
 * Envía un Documento Electrónico individual a la SET.
 */
app.post('/recibe', express.text({ type: '*/*', limit: '10mb' }), async (req: Request, res: Response) => {
  try {
    const xmlSigned = req.body as string;
    if (!xmlSigned || typeof xmlSigned !== 'string' || xmlSigned.trim() === '') {
      return res.status(400).json({ error: 'XML firmado es requerido en el body' });
    }

    const idParam = req.query.id ? parseInt(req.query.id as string) : Date.now();
    const env = AMBIENTE_SET;

    const certInfo = getCertInfo(req);
    if (!certInfo) {
      return res.status(400).json({ error: 'x-ruc y x-password son requeridos en el header' });
    }
    const { certPath, password, ruc } = certInfo;

    if (!fs.existsSync(certPath)) {
      return res.status(404).json({ error: 'Certificado pkcs12 no encontrado' });
    }
    let config = { debug: true, timeout: 90000 };

    console.log(`Invocando recibe RUC: ${ruc}, env: ${env}`);
    const response = await setApi.recibe(idParam, xmlSigned, env, certPath, password, config);

    return res.status(200).json({ id: idParam, numeroLote: response?.numeroLote, response });
  } catch (err: any) {
    console.error('Error recibe:', err);
    return res.status(500).json({ error: err?.message ?? String(err) });
  }
});

/**
 * Envía un Evento a la SET.
 */
app.post('/recibe-evento', express.text({ type: '*/*', limit: '10mb' }), async (req: Request, res: Response) => {
  try {
    const xmlSigned = req.body as string;
    if (!xmlSigned || typeof xmlSigned !== 'string' || xmlSigned.trim() === '') {
      return res.status(400).json({ error: 'XML firmado es requerido en el body' });
    }

    const idParam = req.query.id ? parseInt(req.query.id as string) : Date.now();
    const env = AMBIENTE_SET;

    const certInfo = getCertInfo(req);
    if (!certInfo) {
      return res.status(400).json({ error: 'x-ruc y x-password son requeridos en el header' });
    }
    const { certPath, password, ruc } = certInfo;

    if (!fs.existsSync(certPath)) {
      return res.status(404).json({ error: 'Certificado pkcs12 no encontrado' });
    }
    let config = { debug: true, timeout: 90000 };

    console.log(`Invocando evento RUC: ${ruc}, id: ${idParam}`);
    const response = await setApi.evento(idParam, xmlSigned, env, certPath, password, config);

    return res.status(200).json({ id: idParam, response });
  } catch (err: any) {
    console.error('Error recibe-evento:', err);
    return res.status(500).json({ error: err?.message ?? String(err) });
  }
});

/**
 * Consulta el estado de un lote enviado previamente a la SET.
 */
app.post('/consulta-lote', async (req: Request, res: Response) => {
  try {
    const { id, numeroLote, env } = req.body as { id?: number; numeroLote?: number; env?: string };
    if (!numeroLote) return res.status(400).json({ error: 'numeroLote es requerido en el body' });

    const idParam = id || Date.now();
    const envParam = AMBIENTE_SET;
    const certInfo = getCertInfo(req);
    if (!certInfo) {
      return res.status(400).json({ error: 'x-ruc y x-password son requeridos en el header' });
    }
    const { certPath, password } = certInfo;

    if (!fs.existsSync(certPath)) {
      return res.status(404).json({ error: 'Certificado pkcs12 no encontrado' });
    }

    const response = await setApi.consultaLote(idParam, numeroLote, envParam, certPath, password);
    return res.status(200).json({ numeroLote, estado: response?.estado, response });
  } catch (err: any) {
    console.error('Error consultaLote:', err);
    return res.status(500).json({ error: err?.message ?? String(err) });
  }
});

/**
 * Consulta la validez técnica de un RUC en los servicios de la SET.
 */
app.post('/consulta-ruc', async (req: Request, res: Response) => {
  try {
    const { id, ruc, env } = req.body as { id?: number; ruc?: string; env?: string };
    if (!ruc) return res.status(400).json({ error: 'ruc es requerido en el body' });

    const idParam = id || Date.now();
    const envParam = AMBIENTE_SET;
    const certInfo = getCertInfo(req);
    if (!certInfo) {
      return res.status(400).json({ error: 'x-ruc y x-password son requeridos en el header' });
    }
    const { certPath, password } = certInfo;

    if (!fs.existsSync(certPath)) {
      return res.status(404).json({ error: 'Certificado pkcs12 no encontrado' });
    }

    const response = await setApi.consultaRUC(idParam, ruc, envParam, certPath, password);
    return res.status(200).json({ ruc, estado: response?.estado, response });
  } catch (err: any) {
    console.error('Error consultaRuc:', err);
    return res.status(500).json({ error: err?.message ?? String(err) });
  }
});

/**
 * Consulta un Documento Electrónico por su CDC (Código de Control).
 */
app.post('/consulta-cdc', async (req: Request, res: Response) => {
  try {
    const { id, cdc, env } = req.body as { id?: number; cdc?: string; env?: string };
    if (!cdc) return res.status(400).json({ error: 'cdc es requerido en el body' });

    const idParam = id || Date.now();
    const envParam = AMBIENTE_SET;
    const certInfo = getCertInfo(req);
    if (!certInfo) {
      return res.status(400).json({ error: 'x-ruc y x-password son requeridos en el header' });
    }
    const { certPath, password } = certInfo;

    if (!fs.existsSync(certPath)) {
      return res.status(404).json({ error: 'Certificado pkcs12 no encontrado' });
    }

    const response = await setApi.consulta(idParam, cdc, envParam, certPath, password);
    return res.status(200).json({ id: idParam, cdc, response });
  } catch (err: any) {
    console.error('Error consulta-cdc:', err);
    return res.status(500).json({ error: err?.message ?? String(err) });
  }
});

/**
 * Genera el XML para un evento de cancelación de Documento Electrónico.
 */
app.post('/generar-evento-cancelacion', async (req: Request, res: Response) => {
  try {
    const { id, params, data } = req.body as { id?: number; params?: any; data?: any };
    if (typeof id !== 'number' || Number.isNaN(id)) return res.status(400).json({ error: 'id integer es requerido en el body' });
    if (!data) return res.status(400).json({ error: 'data es requerido en el body' });

    const xml = await xmlgen.generateXMLEventoCancelacion(id, params || {}, data);
    return res.status(200).send(xml);
  } catch (err: any) {
    console.error('Error generando evento de cancelacion:', err);
    return res.status(500).json({ error: err?.message ?? String(err) });
  }
});

const PORT = process.env.PORT || 3000;
app.listen(PORT, () => {
  console.log(`Server FacturaPy listening on port ${PORT}`);
});
