# Chat Action Gateway

Gateway web para que ChatGPT u otros agentes generen enlaces accionables.

El MVP registra gastos personales desde URLs como:

```txt
https://chat-action-gateway.web.app/action/post/expense?amount=183.50&merchant=Oxxo&category=comida&date=2026-06-23&currency=MXN&idempotencyKey=demo-123&token=TOKEN
```

## Stack

- React + Vite para la pagina de resultado.
- Firebase Hosting para servir el frontend.
- Firebase Functions 2nd gen (`apiV2`) con Express.
- Firestore para tokens, gastos, idempotencia y logs.
- Firebase App Check en el cliente y validacion server-side en la Function.

## Desarrollo local

Instalar dependencias:

```sh
npm install
cd server && npm install
```

Crear una copia local de settings del servidor si quieres apagar App Check en emuladores:

```sh
cp server/config/settingsLocal.example.js server/config/settingsLocal.js
```

Levantar frontend:

```sh
npm run dev
```

Levantar emuladores Firebase:

```sh
npm run serve:firebase
```

## Configuracion

El frontend lee:

- `VITE_API_BASE_URL`, por default `/api`.
- `VITE_SITE_KEY_RECAPTCHA`, requerido para inicializar App Check.

El backend usa `server/config/settings.js`, con el mismo patron de AiAssistant:

- primero intenta `server/config/settingsLocal.js`;
- si no existe, lee el secret JSON `CONFIGS_FUNCTIONS`;
- si no hay valor, la variable queda sin definir.

Formato esperado del secret:

```json
{
  "config": {
    "FIREBASE_PROJECT_ID": "chat-action-gateway",
    "FUNCTION_REGION": "us-central1",
    "APP_CHECK_ENFORCEMENT": true
  }
}
```

## Firestore

Las reglas se administran desde la consola de Firebase. La Function escribe con Admin SDK.

Colecciones principales:

- `actionTokens/{tokenHash}`
- `users/{userId}/expenses/{expenseId}`
- `users/{userId}/idempotencyKeys/{idempotencyHash}`
- `actionLogs/{logId}`
- `oauthClients/{clientId}`
- `oauthAuthorizationCodes/{codeHash}`
- `oauthAccessTokens/{accessTokenHash}`
- `oauthRefreshTokens/{refreshTokenHash}`

## MCP para ChatGPT

La misma Function `apiV2` sirve tambien el servidor MCP:

```txt
https://chat-action-gateway.web.app/mcp
```

El MCP usa OAuth para que varias personas puedan usar el mismo servidor sin mezclar gastos. El usuario no escribe `userId` ni token dentro de cada tool. En el flujo de autorizacion pega su token personal una sola vez; el backend calcula `SHA-256(token)`, busca `actionTokens/{tokenHash}` y emite un access token OAuth asociado al `userId` correcto.

Rutas OAuth publicadas:

- Protected resource metadata: `https://chat-action-gateway.web.app/.well-known/oauth-protected-resource`
- Authorization server metadata: `https://chat-action-gateway.web.app/.well-known/oauth-authorization-server`
- Authorization URL: `https://chat-action-gateway.web.app/oauth/authorize`
- Token URL: `https://chat-action-gateway.web.app/oauth/token`
- Dynamic client registration URL: `https://chat-action-gateway.web.app/oauth/register`

Configuracion manual en ChatGPT, si la deteccion automatica no llena todo:

- URL del servidor: `https://chat-action-gateway.web.app/mcp`
- Autenticacion: OAuth
- Metodo de registro: Dynamic client registration, o cliente definido por el usuario con token endpoint auth method `none`
- Authorization server base: `https://chat-action-gateway.web.app`
- Resource: `https://chat-action-gateway.web.app/mcp`
- Scopes: `expenses:write`

Tools disponibles:

- `create_expense`: registra un gasto para el usuario autenticado por OAuth.

La tool no acepta `token` ni `userId`. Esos datos se resuelven desde `Authorization: Bearer <access_token>` en cada request MCP.

## Tokens e idempotencia

El agente debe enviar el token real en la URL:

```txt
token=TOKEN_REAL
```

No debe enviar el hash. La Function calcula internamente:

```txt
tokenHash = SHA-256(TOKEN_REAL)
```

Y busca el documento en firestore:

```txt
actionTokens/{tokenHash}
```

Por eso Firestore no guarda el token real; solo guarda su hash SHA-256 como ID del documento.

Para crear un token nuevo:

1. Genera un token largo y aleatorio.
2. Calcula `SHA-256(token)`.
3. Crea en firestore el documento dentro de su coleccion `actionTokens/{tokenHash}` con los campos `active: true` y el campo `userId` con el valor que quieras.
4. Usa el token real en los enlaces generados por el agente.

El `idempotencyKey` tambien se envia en claro en la URL. La Function lo normaliza a `idempotencyHash` para usarlo como ID seguro en Firestore.
