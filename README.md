# Chat Action Gateway

Gateway web para que ChatGPT use servidores MCP por dominio y registre acciones en Firestore para el usuario autenticado.

## Stack

- React + Vite para la pagina publica de estado.
- Firebase Hosting para servir el frontend.
- Firebase Functions 2nd gen (`apiV2`) con Express.
- Firestore para usuarios, workspaces financieros, cuentas, metodos de pago, movimientos, idempotencia, logs y codigos OAuth temporales.
- Firebase Authentication con Google para identificar al usuario.
- Firebase App Check en la API HTTP normal consumida por el frontend.

## Desarrollo local

Instalar dependencias:

```sh
npm install
cd server && npm install
```

Crear variables locales del frontend y backend:

```sh
cp .env.example .env.local
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
- `VITE_FIREBASE_API_KEY`
- `VITE_FIREBASE_AUTH_DOMAIN`
- `VITE_FIREBASE_PROJECT_ID`
- `VITE_FIREBASE_STORAGE_BUCKET`
- `VITE_FIREBASE_MESSAGING_SENDER_ID`
- `VITE_FIREBASE_APP_ID`
- `VITE_FIREBASE_MEASUREMENT_ID`

El backend usa `server/config/settings.js`, con el mismo patron de AiAssistant:

- en cloud lee el secret JSON `CONFIGS_FUNCTIONS`;
- en local lee variables de `.env` y `.env.local` en la raiz del proyecto;
- si no hay valor, la variable queda sin definir.

Las variables `VITE_*` son las unicas que Vite expone al frontend. Las variables del backend como `OAUTH_ACCESS_TOKEN_SECRET` no se empaquetan en el bundle del navegador.

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

Cada vez que ChatGPT intercambia un authorization code por un access token, el backend incrementa `users/{firebaseUid}.oauthTokenVersion` e incluye esa version en el JWT. Al verificar cada request MCP, la version del token debe coincidir con la version actual del usuario; por eso una nueva autenticacion invalida automaticamente los access tokens anteriores de ese usuario.

En runtime cloud, `APP_CHECK_ENFORCEMENT` falla cerrado: si el valor falta o `CONFIGS_FUNCTIONS` no se puede parsear, la API normal bajo `/api` trata App Check como habilitado. Para apagarlo debe configurarse explicitamente como `false`.

La pantalla de login OAuth vive en el frontend React, en `src/pages/OAuthLogin.jsx`, y usa la config publica de Firebase desde variables `VITE_FIREBASE_*`.

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
https://chat-action-gateway.web.app/mcp/finance
```

El MCP usa OAuth con Google Sign-In. Cuando ChatGPT necesita autorizar el conector, abre `/oauth/authorize`; la Function redirige al frontend `/oauth-login`, ahi el usuario inicia sesion con Google. El backend verifica el ID token de Firebase Auth, crea o actualiza `users/{firebaseUid}`, crea un workspace financiero personal si el usuario aun no tiene workspaces de finanzas y emite el authorization code para ChatGPT.

OAuth solo identifica al usuario y emite access tokens con scopes soportados por el MCP:

```json
[
  "workspaces:read",
  "workspaces:write",
  "members:read",
  "members:write",
  "categories:read",
  "categories:write",
  "accounts:read",
  "accounts:write",
  "payment_methods:read",
  "payment_methods:write",
  "credits:read",
  "credits:write",
  "movements:read",
  "expenses:write",
  "income:write",
  "transfers:write"
]
```

Los permisos reales viven en `financeWorkspaces/{workspaceId}/members/{firebaseUid}.grantedScopes`. Cada tool valida esos scopes del miembro antes de leer o escribir datos del workspace financiero. Para bloquear el acceso de un usuario a un workspace puedes dejar ese array vacio o cambiar `status` a `inactive`.

Rutas OAuth publicadas:

- Protected resource metadata: `https://chat-action-gateway.web.app/.well-known/oauth-protected-resource`
- Authorization server metadata: `https://chat-action-gateway.web.app/.well-known/oauth-authorization-server`
- Authorization URL: `https://chat-action-gateway.web.app/oauth/authorize`
- Token URL: `https://chat-action-gateway.web.app/oauth/token`
- Dynamic client registration URL: `https://chat-action-gateway.web.app/oauth/register`

Configuracion manual en ChatGPT, si la deteccion automatica no llena todo:

- URL del servidor: `https://chat-action-gateway.web.app/mcp/finance`
- Autenticacion: OAuth
- Metodo de registro: Dynamic client registration, o cliente definido por el usuario
- Client ID manual: `chat-action-gateway-chatgpt`
- Token endpoint auth method: `none`
- Authorization server base: `https://chat-action-gateway.web.app`
- Authorization URL: `https://chat-action-gateway.web.app/oauth/authorize`
- Token URL: `https://chat-action-gateway.web.app/oauth/token`
- Registration URL: `https://chat-action-gateway.web.app/oauth/register`
- Resource: `https://chat-action-gateway.web.app/mcp/finance`
- Scopes: `workspaces:read workspaces:write members:read members:write categories:read categories:write accounts:read accounts:write payment_methods:read payment_methods:write credits:read credits:write movements:read expenses:write income:write transfers:write`

Tools disponibles:

- `create_workspace`: crea un workspace `personal`, `household` o `business`.
- `list_workspaces`: lista los workspaces disponibles para elegir `workspaceId`.
- `add_workspace_member`: agrega o actualiza un miembro existente del MCP en un workspace y define su rol.
- `list_workspace_members`: lista miembros de un workspace y sus scopes.
- `list_categories`: lista categorias disponibles del workspace.
- `upsert_category`: crea o actualiza una categoria controlada del workspace.
- `upsert_account`: crea o actualiza una cuenta como BBVA, Mercado Pago o Efectivo.
- `list_accounts`: lista cuentas de un workspace.
- `upsert_payment_method`: crea o actualiza un metodo de pago dentro de una cuenta.
- `list_payment_methods`: lista metodos de pago de una cuenta.
- `list_credits`: lista creditos y compras financiadas.
- `create_credit`: registra creditos/prestamos donde el usuario recibe dinero y queda una deuda.
- `create_credit_purchase`: registra compras a meses, MSI o financiamientos.
- `record_credit_payment`: registra pagos de creditos o compras financiadas.
- `create_expense`: registra un gasto y descuenta saldo de la cuenta.
- `create_income`: registra un ingreso y suma saldo a la cuenta.
- `create_transfer`: mueve dinero entre dos cuentas.
- `set_account_balance`: ajusta el saldo de una cuenta y deja movimiento de auditoria.
- `list_movements`: consulta movimientos por rango de tiempo y filtros, con paginacion por cursor.

Las tools no aceptan `token` ni `userId`. Esos datos se resuelven desde `Authorization: Bearer <access_token>` en cada request MCP.

Las tools devuelven errores estructurados para agentes con `code`, `message`, `agentAction`, `missingFields` y `suggestedTool`. Por ejemplo, si falta `workspaceId` y el usuario tiene varios workspaces, la tool devuelve `workspace_required` y recomienda llamar `list_workspaces`.

Las cuentas nuevas requieren saldo actual explicito. Si el agente intenta crear una cuenta sin `balance`, la tool devuelve `initial_balance_required` para que pregunte al usuario el saldo actual, o confirme que quiere iniciar en `0`.

Las categorias de gastos e ingresos son catalogo controlado por workspace, no texto libre improvisado en cada movimiento. Antes de registrar un gasto o ingreso, el agente debe usar una categoria existente por `categoryId` o `categoryName`. Si no existe, debe llamar `list_categories`, preguntar al usuario si quiere usar una existente o crear una nueva, y solo llamar `upsert_category` cuando el usuario confirme.

Las compras normales pagadas de inmediato usan `create_expense`, incluso si se pagaron con tarjeta de credito. Las compras a meses, MSI, pagos o financiamiento usan `create_credit_purchase`. Los creditos donde entra dinero a una cuenta usan `create_credit`. Los pagos a esos creditos o compras financiadas usan `record_credit_payment`. Un pago general de tarjeta de credito que no corresponde a un credito/plan registrado se modela como `create_transfer` hacia la cuenta `credit_card`; si hubo intereses o comisiones, el agente debe preguntar montos exactos y registrarlos aparte como gasto.

`list_movements` devuelve una pagina de resultados. Si `pagination.hasMore` es `true`, el agente debe decirle al usuario que hay mas movimientos y preguntarle si quiere ver la siguiente pagina. Para continuar, debe llamar otra vez `list_movements` con los mismos filtros y `cursor` igual a `pagination.nextCursor`.

## Firestore

Las reglas se administran desde la consola de Firebase. La Function escribe con Admin SDK.

Colecciones actuales:

- `users/{firebaseUid}`
- `financeWorkspaces/{workspaceId}`
- `financeWorkspaces/{workspaceId}/members/{firebaseUid}`
- `financeWorkspaces/{workspaceId}/categories/{categoryId}`
- `financeWorkspaces/{workspaceId}/accounts/{accountId}`
- `financeWorkspaces/{workspaceId}/accounts/{accountId}/paymentMethods/{paymentMethodId}`
- `financeWorkspaces/{workspaceId}/credits/{creditId}`
- `financeWorkspaces/{workspaceId}/credits/{creditId}/installments/{installmentId}`
- `financeWorkspaces/{workspaceId}/movements/{movementId}`
- `financeWorkspaces/{workspaceId}/idempotencyKeys/{idempotencyHash}`
- `actionLogs/{logId}`
- `oauthAuthorizationCodes/{codeHash}`

`users/{firebaseUid}` mantiene `profiles.finance.workspaceIds` y `profiles.finance.defaultWorkspaceId` para ubicar los workspaces financieros del usuario. `financeWorkspaces/{workspaceId}/members/{firebaseUid}` guarda `role`, `status` y `grantedScopes` para controlar que puede hacer cada miembro dentro de ese workspace. Los usuarios solo pueden usar las tools cuyos scopes existan en su documento de miembro. Los owners nuevos se crean con todos los scopes en su documento `members/{firebaseUid}`.

`financeWorkspaces/{workspaceId}/categories/{categoryId}` guarda categorias reutilizables con `name`, `normalizedName`, `type` (`expense`, `income`, `both`), `description` y `active`. Los movimientos guardan `categoryId`, `categoryName` y `category` para mantener referencia al catalogo y lectura simple.

Para agregar miembros con `add_workspace_member`, la persona ya debe haber iniciado sesion una vez con Google en este MCP. La tool puede buscarla por `memberEmail` o por `memberUserId`. Si no existe, la tool devuelve `member_user_not_found` para que el agente le indique que primero conecte el MCP con Google.

Roles de miembros:

- `viewer`: solo lectura.
- `member`: lectura y escritura financiera, sin administrar miembros.
- `admin`: todas las tools del workspace, incluyendo administracion de miembros.

Los movimientos viven en una coleccion unificada con `type`:

- `expense`
- `income`
- `transfer`
- `balance_adjustment`
- `credit_disbursement`
- `credit_purchase`
- `credit_payment`

Cada movimiento guarda `lines` con los impactos por cuenta. Un gasto tiene una linea negativa, un ingreso una positiva, y una transferencia una negativa en origen y una positiva en destino. Los movimientos de credito separan desembolsos, compras financiadas y pagos para no mezclar pagos de capital con intereses/comisiones.

Colecciones antiguas que ya no usa el codigo:

- `actionTokens`
- `oauthClients`
- `oauthAccessTokens`
- `oauthRefreshTokens`

Despues de desplegar y probar el login nuevo, esas colecciones antiguas se pueden borrar desde la consola si ya no necesitas historial.

## Idempotencia

Cada tool MCP de escritura financiera pide `idempotencyKey`. El agente debe generar una clave nueva para cada movimiento real, con formato estable y unico para esa intencion de escritura, por ejemplo:

```txt
expense:2026-06-26:oxxo-cafe:8f3a21
transfer:2026-06-26:bbva-a-mercado-pago:1720
```

La misma clave solo debe reutilizarse al reintentar exactamente la misma llamada por una falla tecnica. Para otro movimiento real, incluso si se parece en monto, comercio, cuenta y fecha, se debe generar otra clave.

La Function calcula el hash usando accion, fecha del movimiento e `idempotencyKey`:

```txt
idempotencyHash = SHA-256(action + movement.date + idempotencyKey)
```

Luego lo guarda como ID seguro en:

```txt
financeWorkspaces/{workspaceId}/idempotencyKeys/{idempotencyHash}
```
