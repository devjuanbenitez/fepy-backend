# 📋 Gestión de Eventos SIFEN - Implementación

## 📖 Descripción

Implementación del sistema de eventos de SIFEN según el **Manual Técnico v150 - Sección 11**.

Los eventos permiten registrar acciones sobre facturas electrónicas ya aprobadas por la SET, como:
- Cancelación por el emisor
- Disconformidad por el receptor
- Conformidad por el receptor
- Desconocimiento de la operación
- Notificación de recepción

---

## ⚠️ Importante: Estados y Eventos

**Según el Manual Técnico v150:**

> "Los eventos del receptor **no invalidarán el DE o DTE**, sino que **quedarán marcados en el SIFEN**."

Esto significa que:
- ✅ El estado `aceptado` de una factura **NO cambia** después de registrado un evento
- ✅ Los eventos solo "marcan" el documento en la SET
- ✅ Una factura aprobada sigue estando aprobada aunque tenga eventos

---

## 🔧 Tipos de Eventos Soportados

### Eventos del Emisor

| Tipo | Código | Descripción | Plazo |
|------|--------|-------------|-------|
| **Cancelación** | `cancelacion` | El emisor cancela el DTE | 48hs después de aprobación |
| **Devolución/Ajuste** | `devolucion_ajuste` | Automático por NC/ND electrónica | - |

### Eventos del Receptor

| Tipo | Código | Descripción | Plazo |
|------|--------|-------------|-------|
| **Conformidad** | `conformidad` | Receptor confirma que todo está correcto | 15 días |
| **Disconformidad** | `disconformidad` | Receptor reporta errores o inconsistencias | 15 días |
| **Desconocimiento** | `desconocimiento` | Receptor desconoce la operación | 15 días |
| **Notificación de Recepción** | `notificacion_recepcion` | Receptor acusa recibo (sin pronunciarse) | - |

---

## 📡 Endpoints de API

### 1. Enviar Evento

```http
POST /api/eventos/enviar
Content-Type: application/json
Authorization: Bearer {token}

{
  "invoiceId": "67f8a9b2c3d4e5f6a7b8c9d0",
  "tipoEvento": "disconformidad",
  "descripcion": "Los ítems 3 y 4 no coinciden con la orden de compra",
  "usuario": {
    "documentoNumero": "1234567",
    "nombre": "Juan Pérez"
  }
}
```

**Respuesta exitosa:**
```json
{
  "success": true,
  "message": "Evento enviado a SET correctamente",
  "data": {
    "eventoId": "67f8a9b2c3d4e5f6a7b8c9d1",
    "idEventoSET": "abc123...",
    "codigoRetorno": "0000",
    "mensajeRetorno": "Evento registrado correctamente",
    "estadoEvento": "registrado",
    "tipoEvento": "disconformidad",
    "cdc": "01036040761001...",
    "correlativo": "001-001-0000001"
  }
}
```

**Validaciones:**
- ✅ La factura debe existir
- ✅ La factura debe tener CDC (estar aprobada por SET)
- ✅ El tipo de evento debe ser válido
- ✅ La descripción es obligatoria

---

### 2. Obtener Eventos de una Factura

```http
GET /api/eventos/factura/:invoiceId
Authorization: Bearer {token}
```

**Respuesta:**
```json
{
  "success": true,
  "total": 2,
  "eventos": [
    {
      "_id": "67f8a9b2c3d4e5f6a7b8c9d1",
      "invoiceId": "67f8a9b2c3d4e5f6a7b8c9d0",
      "cdc": "01036040761001...",
      "tipoEvento": "disconformidad",
      "descripcion": "Los ítems no coinciden",
      "estadoEvento": "registrado",
      "codigoRetorno": "0000",
      "mensajeRetorno": "Evento registrado correctamente",
      "createdAt": "2026-03-05T10:30:00.000Z"
    }
  ]
}
```

---

### 3. Obtener Eventos por CDC

```http
GET /api/eventos/cdc/:cdc
Authorization: Bearer {token}
```

---

### 4. Obtener Detalle de Evento

```http
GET /api/eventos/:id
Authorization: Bearer {token}
```

---

### 5. Listar Eventos (con filtros)

```http
GET /api/eventos?tipoEvento=disconformidad&estadoEvento=registrado&page=1&limit=10
Authorization: Bearer {token}
```

---

### 6. Obtener Eventos desde Factura

```http
GET /api/invoices/:id/eventos
Authorization: Bearer {token}
```

**Respuesta:**
```json
{
  "success": true,
  "total": 2,
  "eventos": [...]
}
```

---

## 🗂️ Modelo de Datos (Evento.js)

```javascript
{
  invoiceId: ObjectId,       // Referencia a Invoice
  cdc: String,               // CDC del documento (44 dígitos)
  correlativo: String,       // Número de factura
  
  tipoEvento: String,        // Tipo de evento
  descripcion: String,       // Descripción/motivo
  
  xmlEvento: String,         // XML del evento sin firmar
  xmlFirmado: String,        // XML firmado
  
  estadoEvento: String,      // enviado|registrado|rechazado|error
  codigoRetorno: String,     // Código de retorno SET
  mensajeRetorno: String,    // Mensaje de SET
  idEventoSET: String,       // ID en SET
  
  empresaId: ObjectId,       // Empresa emisora
  rucEmpresa: String,
  rucReceptor: String,       // RUC del receptor
  
  usuario: {
    tipo: String,            // emisor|receptor
    documentoNumero: String,
    nombre: String
  },
  
  createdAt: Date,
  updatedAt: Date
}
```

---

## 🔄 Flujo de Envío de Evento

```
1. Usuario solicita enviar evento
   ↓
2. Backend valida:
   - Factura existe
   - Factura tiene CDC
   - Factura está "aceptado"
   ↓
3. Generar XML del evento (Evento_v150.xsd)
   ↓
4. Firmar XML con certificado de la empresa
   ↓
5. Enviar a SET vía setApi.evento()
   ↓
6. SET responde con código de retorno
   ↓
7. Backend guarda evento en BD
   ↓
8. Frontend muestra resultado
```

---

## 📝 Ejemplo de XML de Evento

```xml
<?xml version="1.0" encoding="UTF-8"?>
<evento xmlns="http://ekuatia.set.gov.py/sifen/xsd">
  <id>abc123def456...</id>
  <cdc>01036040761001001000000322026022719876543220</cdc>
  <tipoEvento>disconformidad</tipoEvento>
  <descripcion>Los ítems 3 y 4 no coinciden con la orden de compra</descripcion>
  <fechaEvento>2026-03-05T10:30:00</fechaEvento>
  <rucEmisor>80012345-1</rucEmisor>
  <rucReceptor>20050011-0</rucReceptor>
  <usuario>
    <documentoNumero>1234567</documentoNumero>
    <nombre>Juan Pérez</nombre>
  </usuario>
</evento>
```

---

## 🎨 Frontend (InvoiceDetailView.vue)

La vista de detalle de factura ahora muestra:

1. **Sección "Eventos SIFEN"** (solo si factura está `aceptado` y tiene CDC)
2. **Tabla de eventos** con:
   - Tipo de evento (chip de color)
   - Descripción
   - Estado (registrado, enviado, rechazado)
   - Fecha de registro
   - Código de retorno

**Colores por tipo de evento:**
- 🔴 **Cancelación**: Rojo
- 🟢 **Conformidad**: Verde
- 🟠 **Disconformidad**: Naranja
- 🟣 **Desconocimiento**: Púrpura
- 🔵 **Notificación de Recepción**: Azul
- 🟡 **Devolución/Ajuste**: Ámbar

---

## 🧪 Testing

### Enviar evento de disconformidad

```bash
# 1. Obtener token
TOKEN=$(curl -X POST http://localhost:8081/api/auth/login \
  -H "Content-Type: application/json" \
  -d '{"email":"admin@test.com","password":"admin123"}' | jq -r '.token')

# 2. Obtener ID de factura aprobada
FACTURA_ID=$(curl -s "http://localhost:8081/api/invoices?estado=aceptado" \
  -H "Authorization: Bearer $TOKEN" | jq -r '.invoices[0]._id')

# 3. Enviar evento
curl -X POST "http://localhost:8081/api/eventos/enviar" \
  -H "Content-Type: application/json" \
  -H "Authorization: Bearer $TOKEN" \
  -d "{
    \"invoiceId\": \"$FACTURA_ID\",
    \"tipoEvento\": \"disconformidad\",
    \"descripcion\": \"Prueba de disconformidad\",
    \"usuario\": {
      \"documentoNumero\": \"1234567\",
      \"nombre\": \"Juan Pérez\"
    }
  }" | jq .
```

### Ver eventos de una factura

```bash
curl "http://localhost:8081/api/invoices/$FACTURA_ID/eventos" \
  -H "Authorization: Bearer $TOKEN" | jq .
```

---

## 📚 Referencias

- **Manual Técnico v150** - Sección 11: Gestión de Eventos
- **Schema XML 19**: Evento_v150.xsd
- **Schema XML 12**: ContenedorEvento_v150.xsd
- **Schema XML 14**: resRecepEvento_v150.xsd

---

## ⚠️ Consideraciones

1. **Solo facturas aprobadas** pueden tener eventos
2. **El estado no cambia** después de registrar un evento
3. **Los eventos son irreversibles** una vez registrados en SET
4. **Plazo de 15 días** para eventos del receptor (conformidad/disconformidad)
5. **Plazo de 48 horas** para cancelación por el emisor

---

## 🔄 Próximas Implementaciones

- [ ] Endoso de FE (evento futuro)
- [ ] Impugnación por SET (evento futuro)
- [ ] Actualización de datos del transporte
- [ ] Lote de eventos (envío múltiple)
- [ ] Reintentos de eventos fallidos
