# Chat Action Gateway

Gateway web para que ChatGPT use un servidor MCP y registre acciones en Firestore para el usuario autenticado.

## Stack

- React + Vite para la pagina publica de estado.
- Firebase Hosting para servir el frontend.
- Firebase Functions 2nd gen (`apiV2`) con Express.
- Firestore para usuarios, workspaces, cuentas, metodos de pago, movimientos, idempotencia, logs y codigos OAuth temporales.
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

El MCP usa OAuth con Google Sign-In. Cuando ChatGPT necesita autorizar el conector, abre `/oauth/authorize`; la Function redirige al frontend `/oauth-login`, ahi el usuario inicia sesion con Google. El backend verifica el ID token de Firebase Auth, crea o actualiza `users/{firebaseUid}`, crea un workspace personal si el usuario aun no tiene workspaces y emite el authorization code para ChatGPT.

OAuth solo identifica al usuario y emite access tokens con scopes soportados por el MCP:

```json
[
  "workspaces:read",
  "workspaces:write",
  "members:read",
  "members:write",
  "accounts:read",
  "accounts:write",
  "payment_methods:read",
  "payment_methods:write",
  "movements:read",
  "expenses:write",
  "income:write",
  "transfers:write"
]
```

Los permisos reales viven en `workspaces/{workspaceId}/members/{firebaseUid}.grantedScopes`. Cada tool valida esos scopes del miembro antes de leer o escribir datos del workspace. Para bloquear el acceso de un usuario a un workspace puedes dejar ese array vacio o cambiar `status` a `inactive`.

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
- Scopes: `workspaces:read workspaces:write members:read members:write accounts:read accounts:write payment_methods:read payment_methods:write movements:read expenses:write income:write transfers:write`

Tools disponibles:

- `create_workspace`: crea un workspace personal o de negocio.
- `list_workspaces`: lista los workspaces disponibles para elegir `workspaceId`.
- `add_workspace_member`: agrega o actualiza un miembro existente del MCP en un workspace y define sus scopes por workspace.
- `list_workspace_members`: lista miembros de un workspace y sus scopes.
- `upsert_account`: crea o actualiza una cuenta como BBVA, Mercado Pago o Efectivo.
- `list_accounts`: lista cuentas de un workspace.
- `upsert_payment_method`: crea o actualiza un metodo de pago dentro de una cuenta.
- `list_payment_methods`: lista metodos de pago de una cuenta.
- `create_expense`: registra un gasto y descuenta saldo de la cuenta.
- `create_income`: registra un ingreso y suma saldo a la cuenta.
- `create_transfer`: mueve dinero entre dos cuentas.
- `set_account_balance`: ajusta el saldo de una cuenta y deja movimiento de auditoria.
- `list_movements`: consulta movimientos por rango de tiempo y filtros.

Las tools no aceptan `token` ni `userId`. Esos datos se resuelven desde `Authorization: Bearer <access_token>` en cada request MCP.

Las tools devuelven errores estructurados para agentes con `code`, `message`, `agentAction`, `missingFields` y `suggestedTool`. Por ejemplo, si falta `workspaceId` y el usuario tiene varios workspaces, la tool devuelve `workspace_required` y recomienda llamar `list_workspaces`.

Las cuentas nuevas requieren saldo actual explicito. Si el agente intenta crear una cuenta sin `balance`, la tool devuelve `initial_balance_required` para que pregunte al usuario el saldo actual, o confirme que quiere iniciar en `0`.

## Firestore

Las reglas se administran desde la consola de Firebase. La Function escribe con Admin SDK.

Colecciones actuales:

- `users/{firebaseUid}`
- `workspaces/{workspaceId}`
- `workspaces/{workspaceId}/members/{firebaseUid}`
- `workspaces/{workspaceId}/accounts/{accountId}`
- `workspaces/{workspaceId}/accounts/{accountId}/paymentMethods/{paymentMethodId}`
- `workspaces/{workspaceId}/movements/{movementId}`
- `workspaces/{workspaceId}/idempotencyKeys/{idempotencyHash}`
- `actionLogs/{logId}`
- `oauthAuthorizationCodes/{codeHash}`

`users/{firebaseUid}` mantiene `workspaces` y `defaultWorkspaceId` para ubicar los espacios del usuario. `workspaces/{workspaceId}/members/{firebaseUid}` guarda `role`, `status` y `grantedScopes` para controlar que puede hacer cada miembro dentro de ese workspace. Los usuarios solo pueden usar las tools cuyos scopes existan en su documento de miembro. Los owners nuevos se crean con todos los scopes en su documento `members/{firebaseUid}`.

Para agregar miembros con `add_workspace_member`, la persona ya debe haber iniciado sesion una vez con Google en este MCP. La tool puede buscarla por `memberEmail` o por `memberUserId`. Si no existe, la tool devuelve `member_user_not_found` para que el agente le indique que primero conecte el MCP con Google.

Los movimientos viven en una coleccion unificada con `type`:

- `expense`
- `income`
- `transfer`
- `balance_adjustment`

Cada movimiento guarda `lines` con los impactos por cuenta. Un gasto tiene una linea negativa, un ingreso una positiva, y una transferencia una negativa en origen y una positiva en destino.

Colecciones antiguas que ya no usa el codigo:

- `actionTokens`
- `oauthClients`
- `oauthAccessTokens`
- `oauthRefreshTokens`

Despues de desplegar y probar el login nuevo, esas colecciones antiguas se pueden borrar desde la consola si ya no necesitas historial.

## Idempotencia

Cada escritura financiera acepta `idempotencyKey`. Si no se envia, el MCP genera uno. La Function lo normaliza a `idempotencyHash` para usarlo como ID seguro en:

```txt
workspaces/{workspaceId}/idempotencyKeys/{idempotencyHash}
```
