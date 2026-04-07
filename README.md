# FEPY Backend - Sistema de Facturación Electrónica SIFEN

Sistema robusto de facturación electrónica para Paraguay (SIFEN) con procesamiento asíncrono, gestión de lotes y eventos, y recuperación automática de documentos.

## 📋 Descripción General

API RESTful diseñada para la emisión, gestión y monitoreo de Documentos Electrónicos (DE) ante el sistema SIFEN de la SET. Utiliza procesamiento asíncrono para garantizar alta disponibilidad y tolerancia a fallos.

**Características principales:**
- ✅ **Procesamiento Asíncrono**: Colas de trabajo (Bull + Redis) para generación y envío.
- ✅ **Gestión de Lotes**: Agrupación inteligente de facturas para envío diferido por lotes (Estrategia Asincrónica).
- ✅ **Eventos SIFEN**: Soporte para Cancelaciones, Conformidad, y más de 5 tipos de eventos del receptor/emisor.
- ✅ **Sincronización Inteligente**: Consulta de estados por CDC con detección automática de eventos externos (ej. cancelaciones previas en SET).
- ✅ **Resiliencia**: Recuperación y regeneración "on-demand" de archivos XML y KUDE (PDF) faltantes.
- ✅ **Seguridad**: Autenticación vía JWT y API Keys, con encriptación AES-256 para certificados .p12.
- ✅ **Multi-empresa**: Soporte multi-tenant con configuraciones independientes por RUC.

---

## 🏗️ Arquitectura de Procesamiento

El sistema se divide en dos componentes principales que pueden correr en paralelo:

1.  **API Server (server.js)**: Recibe las solicitudes, valida datos, gestiona la persistencia en MongoDB y encola tareas.
2.  **Workers**:
    *   **FacturaWorker**: Genera el XML, gestiona la firma digital, inserta el QR y realiza el envío individual (si aplica).
    *   **LotesManager**: Monitorea facturas pendientes de envío agrupado, arma los lotes y consulta el estado asíncrono de los mismos ante la SET.

---

## 📊 Gestión de Estados y Reintentos

### El Campo `proceso` (Control de Integridad)
A diferencia del `estadoSifen`, el campo `proceso` de la factura determina si el flujo de generación de archivos locales fue exitoso:

| Valor | Significado | Comportamiento |
| :--- | :--- | :--- |
| `null` | Pendiente | La factura acaba de entrar al sistema o está en cola. |
| `Terminado` | Éxito Total | Existen físicamente tanto el **XML firmado** como el **KUDE (PDF)**. No permite duplicados. |
| `Fallido` | Error Interno | Algún paso (XML o PDF) falló. **Permite el reenvío/reintento** desde el origen usando el mismo `facturaHash`. |

### Sincronización de Estados (SIFEN)
El sistema interpreta los códigos de retorno de la SET de forma adaptativa:
- **Código 0422 (CDC Encontrado)**: El sistema no solo marca como "Aceptado", sino que inspecciona el contenido XML (xContenDE). Si detecta un evento de cancelación previo en la SET (`<rGeVeCan>`), el sistema local se sincroniza automáticamente a estado **Cancelado**.
- **Errores Temporales (0160, 0161)**: Ante errores de comunicación o "XML Mal Formado" (generalmente por saturación de la SET), la factura se mantiene en estado `procesando` para permitir consultas posteriores de actualización sin marcarla como rechazada definitivamente.

---

## 📦 Estrategias de Envío: Lotes vs Individual

El sistema permite configurar la estrategia por empresa:

### Envíos Individuales
Ideal para bajo volumen. La factura se envía inmediatamente después de ser firmada.

### Envíos por Lotes (Asíncronos)
Optimizado para alto volumen:
1.  Las facturas se firman y quedan en estado `esperando_lote`.
2.  El **LotesManager** agrupa hasta 50 documentos por lote o dispara el envío tras cumplirse un tiempo límite (ej. 1 hora).
3.  El sistema monitorea el número de protocolo del lote hasta que la SET concluye el procesamiento.
4.  **Corrección de Arrays**: El motor de extracción soporta respuestas de lote con múltiples documentos sin pérdida de integridad en la lectura de los resultados individuales.

---

## 📄 Gestión de Documentos (XML y KUDE)

### Almacenamiento Estructurado
Los archivos se organizan por RUC, año y mes en el directorio `de_output`:
`de_output/{RUC}/{AÑO}/{MES}/Factura_electronica_{CORRELATIVO}.pdf`

### Regeneración Automática
El endpoint de descarga implementa una lógica de **Fallback**:
Si un usuario solicita un PDF y este ha sido borrado accidentalmente del disco, el backend dispara una llamada a `generarKUDE` en tiempo real para recrear el documento basándose en el XML y los datos de la base de datos, asegurando que los enlaces de descarga siempre funcionen.

---

## 📡 Endpoints de API (Resumen)

### Facturación
- `POST /api/facturar/crear`: Envío de datos para nueva factura (Asíncrono).
- `GET /api/invoices`: Listado de facturas con filtros.
- `GET /api/invoices/:id/download-pdf`: Descarga/Regeneración de KUDE.
- `GET /api/invoices/:id/download-xml`: Descarga de XML firmado.

### Lotes
- `GET /api/lotes?empresaId=...`: Listado de lotes con **paginación integrada**.
- `POST /api/lotes/:id/forzar-consulta-cdc`: Rastrillaje manual de emergencia para lotes estancados por más de 48hs.

### Eventos
- `POST /api/eventos/enviar`: Registro de cancelaciones y otros eventos ante la SET.

---

## 🚀 Instalación y Scripts

```bash
# Instalación de dependencias y parches de librerías
npm install
node patch-kude.js

# Scripts disponibles
npm start           # Inicia el Servidor de API
npm run worker      # Inicia el Worker de Procesamiento
npm run start:all   # Inicia API + Worker simultáneamente (Concurrently)
npm run dev         # Modo desarrollo con nodemon
```

---

## 📚 Requisitos Técnicos
- **Node.js**: 16+
- **MongoDB**: 6.0+
- **Redis**: 6.2+
- **Java**: JRE 8+ (indispensable para el motor de Jasper/KUDE)

---
Proyecto desarrollado por **Jara Network** para la modernización tributaria.
MIT License.
