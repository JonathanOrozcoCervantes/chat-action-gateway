# Chat Action Gateway

## Resumen del proyecto

Chat Action Gateway es un puente entre ChatGPT y sistemas internos propios. El proyecto expone un servidor MCP que ChatGPT puede conectar mediante OAuth, autentica a cada persona con Google/Firebase Auth y registra acciones en Firestore bajo el usuario correcto.

El primer caso de uso es finanzas personales: registrar gastos desde ChatGPT. La arquitectura debe permitir agregar mas herramientas MCP y endpoints HTTP normales en el futuro.

## Modelo actual

El flujo principal ya no usa enlaces `/action/...` con `token` por URL. El modelo actual es:

1. ChatGPT conecta el servidor MCP.
2. ChatGPT inicia el flujo OAuth en `/oauth/authorize`.
3. La Function redirige al frontend `/oauth-login`.
4. El usuario inicia sesion con Google.
5. Firebase Authentication entrega un ID token.
6. La Function verifica el ID token con Admin SDK.
7. Se crea o actualiza `users/{firebaseUid}`.
8. El backend valida que el usuario tenga en `grantedScopes` los permisos solicitados.
9. ChatGPT recibe un access token OAuth con los scopes concedidos.
10. Cada tool MCP usa `Authorization: Bearer <access_token>`.
11. El backend resuelve el usuario desde el access token y escribe en `users/{firebaseUid}`.

Este modelo permite que muchas personas usen el mismo MCP sin mezclar registros.

## Caso de uso inicial: gastos personales

La tool MCP inicial es `create_expense`.

Campos esperados:

```txt
amount
merchant
category
date
currency
description
paymentMethod
notes
idempotencyKey
```

Campos requeridos:

```txt
amount
merchant
category
date
currency
idempotencyKey
```

La fecha debe usar formato `YYYY-MM-DD` y `currency` debe ser un codigo ISO 4217 como `MXN` o `USD`.

## Comportamiento esperado del agente

Antes de llamar la tool, ChatGPT debe:

1. Extraer datos del ticket, recibo o mensaje del usuario.
2. Inferir una categoria si hay informacion suficiente.
3. Preguntar al usuario por campos requeridos que falten o sean ambiguos.
4. Dar un resumen breve de lo que se va a registrar.
5. Llamar `create_expense` solo cuando tenga datos suficientes.

Ejemplo de resumen:

```txt
Voy a registrar $183.50 MXN en Oxxo, categoria comida, fecha 2026-06-23, pagado con tarjeta.
```

## Firestore

Colecciones actuales:

```txt
users/{firebaseUid}
users/{firebaseUid}/expenses/{expenseId}
users/{firebaseUid}/idempotencyKeys/{idempotencyHash}
actionLogs/{logId}
oauthAuthorizationCodes/{codeHash}
```

`users/{firebaseUid}` usa el UID real de Firebase Authentication como ID del documento.

Cada usuario tiene un campo array `grantedScopes`. Si el campo no existe al hacer login, se inicializa con:

```txt
expenses:write
```

El access token OAuth solo incluye scopes que hayan sido solicitados por ChatGPT y que tambien existan en `users/{firebaseUid}.grantedScopes`. Cada request MCP vuelve a validar el scope requerido contra el array actual del usuario.

## Idempotencia

Cada gasto debe incluir `idempotencyKey`. El backend calcula:

```txt
idempotencyHash = SHA-256(idempotencyKey)
```

Y lo guarda en:

```txt
users/{firebaseUid}/idempotencyKeys/{idempotencyHash}
```

Si ya existe, se rechaza la accion como duplicada.

## API HTTP normal

La API normal queda separada del MCP bajo `/api`.

Endpoint de referencia:

```txt
GET /api/ping
```

Ese endpoint pasa por:

```txt
routes -> controller -> use case -> service -> repository
```

La API normal debe servir como base para futuros endpoints HTTP propios. No debe mezclarse con el protocolo MCP.

## Rutas publicas importantes

```txt
/mcp
/.well-known/oauth-protected-resource
/.well-known/oauth-authorization-server
/oauth/authorize
/oauth/token
/oauth/register
/api/ping
```

## Requisitos funcionales del MVP

- Autenticar al usuario del MCP con Google/Firebase Auth.
- Crear o actualizar `users/{firebaseUid}` sin duplicar usuarios.
- Registrar gastos en `users/{firebaseUid}/expenses`.
- Evitar duplicados con `idempotencyKey`.
- Guardar logs de cada intento de registro.
- Mantener la API HTTP normal separada del MCP.
- Dejar una referencia clara para agregar nuevos endpoints API.
- Dejar una referencia clara para agregar nuevas tools MCP.
