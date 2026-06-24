# Chat Action Gateway

Gateway web para que ChatGPT use un servidor MCP y registre acciones en Firestore para el usuario autenticado.

## Stack

- React + Vite para la pagina publica de estado.
- Firebase Hosting para servir el frontend.
- Firebase Functions 2nd gen (`apiV2`) con Express.
- Firestore para usuarios, gastos, idempotencia, logs y codigos OAuth temporales.
- Firebase Authentication con Google para identificar al usuario.
- Firebase App Check en la API HTTP normal consumida por el frontend.

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

- en cloud lee el secret JSON `CONFIGS_FUNCTIONS`;
- en local intenta `server/config/settingsLocal.js`;
- si no hay valor, la variable queda sin definir.

Formato esperado del secret:

```json
{
  "config": {
    "FIREBASE_PROJECT_ID": "chat-action-gateway",
    "FUNCTION_REGION": "us-central1",
    "APP_CHECK_ENFORCEMENT": true,
    "OAUTH_ACCESS_TOKEN_SECRET": "un-secreto-largo-aleatorio"
  }
}
```

`OAUTH_ACCESS_TOKEN_SECRET` firma los access tokens JWT que usa el MCP. Cambiarlo invalida los access tokens emitidos antes.

La pantalla de login OAuth vive en el frontend React, en `src/pages/OAuthLogin.jsx`, y usa la config publica de `src/firebase.js`.

## API HTTP Normal

La API normal vive bajo `/api` y pasa por App Check:

```txt
GET https://chat-action-gateway.web.app/api/ping
```

Este endpoint existe como referencia de arquitectura:

- `server/routes/apiRoutes.js`
- `server/controllers/apiController.js`
- `server/useCases/apiUseCase.js`
- `server/services/apiService.js`
- `server/repositories/apiRepository.js`

El endpoint viejo `/action/...` con `token` por URL ya no existe.

## MCP para ChatGPT

La misma Function `apiV2` sirve el servidor MCP:

```txt
https://chat-action-gateway.web.app/mcp
```

El MCP usa OAuth con Google Sign-In. Cuando ChatGPT necesita autorizar el conector, abre `/oauth/authorize`; la Function redirige al frontend `/oauth-login`, ahi el usuario inicia sesion con Google. El backend verifica el ID token de Firebase Auth, crea o actualiza `users/{firebaseUid}` y emite el authorization code para ChatGPT.

Rutas OAuth publicadas:

- Protected resource metadata: `https://chat-action-gateway.web.app/.well-known/oauth-protected-resource`
- Authorization server metadata: `https://chat-action-gateway.web.app/.well-known/oauth-authorization-server`
- Authorization URL: `https://chat-action-gateway.web.app/oauth/authorize`
- Token URL: `https://chat-action-gateway.web.app/oauth/token`
- Dynamic client registration URL: `https://chat-action-gateway.web.app/oauth/register`

Configuracion manual en ChatGPT, si la deteccion automatica no llena todo:

- URL del servidor: `https://chat-action-gateway.web.app/mcp`
- Autenticacion: OAuth
- Metodo de registro: Dynamic client registration, o cliente definido por el usuario
- Client ID manual: `chat-action-gateway-chatgpt`
- Token endpoint auth method: `none`
- Authorization server base: `https://chat-action-gateway.web.app`
- Authorization URL: `https://chat-action-gateway.web.app/oauth/authorize`
- Token URL: `https://chat-action-gateway.web.app/oauth/token`
- Registration URL: `https://chat-action-gateway.web.app/oauth/register`
- Resource: `https://chat-action-gateway.web.app/mcp`
- Scopes: `expenses:write`

Tools disponibles:

- `create_expense`: registra un gasto para el usuario autenticado por OAuth.

La tool no acepta `token` ni `userId`. Esos datos se resuelven desde `Authorization: Bearer <access_token>` en cada request MCP.

## Firestore

Las reglas se administran desde la consola de Firebase. La Function escribe con Admin SDK.

Colecciones actuales:

- `users/{firebaseUid}`
- `users/{firebaseUid}/expenses/{expenseId}`
- `users/{firebaseUid}/idempotencyKeys/{idempotencyHash}`
- `actionLogs/{logId}`
- `oauthAuthorizationCodes/{codeHash}`

Colecciones antiguas que ya no usa el codigo:

- `actionTokens`
- `oauthClients`
- `oauthAccessTokens`
- `oauthRefreshTokens`

Despues de desplegar y probar el login nuevo, esas colecciones antiguas se pueden borrar desde la consola si ya no necesitas historial.

## Idempotencia

Cada gasto requiere un `idempotencyKey`. La Function lo normaliza a `idempotencyHash` para usarlo como ID seguro en:

```txt
users/{firebaseUid}/idempotencyKeys/{idempotencyHash}
```
