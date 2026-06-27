# Chat Action Gateway

## Resumen del proyecto

Chat Action Gateway es un puente entre ChatGPT y sistemas internos propios. El proyecto expone servidores MCP por dominio que ChatGPT puede conectar mediante OAuth, autentica a cada persona con Google/Firebase Auth y registra acciones financieras en Firestore bajo el workspace correcto.

La etapa actual es Finanzas personales pro. El modelo debe permitir crecer despues a microempresarios con facturas, clientes, proveedores, ventas y compras sin reorganizar las colecciones principales.

## Modelo actual

El flujo principal ya no usa enlaces `/action/...` con `token` por URL. El modelo actual es:

1. ChatGPT conecta el servidor MCP de finanzas.
2. ChatGPT inicia el flujo OAuth en `/oauth/authorize`.
3. La Function redirige al frontend `/oauth-login`.
4. El usuario inicia sesion con Google.
5. Firebase Authentication entrega un ID token.
6. La Function verifica el ID token con Admin SDK.
7. Se crea o actualiza `users/{firebaseUid}`.
8. Si el usuario no tiene workspaces de finanzas, se crea un workspace financiero personal.
9. El backend valida que los scopes solicitados existan en la lista soportada por el MCP.
10. ChatGPT recibe un access token OAuth con los scopes concedidos.
11. Cada request MCP usa `Authorization: Bearer <access_token>`.
12. Cada request MCP valida que la version del token coincida con `users/{firebaseUid}.oauthTokenVersion`.
13. Cada tool valida el scope especifico contra `financeWorkspaces/{workspaceId}/members/{firebaseUid}.grantedScopes` y escribe o consulta en el workspace correcto.

Este modelo permite que muchas personas usen el mismo MCP sin mezclar registros.

## Modelo Firestore

```txt
users/{firebaseUid}
financeWorkspaces/{workspaceId}
financeWorkspaces/{workspaceId}/members/{firebaseUid}
financeWorkspaces/{workspaceId}/categories/{categoryId}
financeWorkspaces/{workspaceId}/accounts/{accountId}
financeWorkspaces/{workspaceId}/accounts/{accountId}/paymentMethods/{paymentMethodId}
financeWorkspaces/{workspaceId}/movements/{movementId}
financeWorkspaces/{workspaceId}/idempotencyKeys/{idempotencyHash}
actionLogs/{logId}
oauthAuthorizationCodes/{codeHash}
```

`users/{firebaseUid}` usa el UID real de Firebase Authentication como ID del documento. Tambien mantiene:

```txt
profiles.finance.workspaceIds
profiles.finance.defaultWorkspaceId
oauthTokenVersion
```

`oauthTokenVersion` se incrementa cada vez que ChatGPT intercambia un authorization code por un access token. El JWT emitido incluye esa version; si el usuario vuelve a autenticar el MCP, los tokens anteriores dejan de coincidir y quedan invalidados.

`financeWorkspaces/{workspaceId}/members/{firebaseUid}` queda como base para roles y permisos por workspace.

## Scopes OAuth

El MCP soporta:

```txt
workspaces:read
workspaces:write
members:read
members:write
categories:read
categories:write
accounts:read
accounts:write
payment_methods:read
payment_methods:write
movements:read
expenses:write
income:write
transfers:write
```

El access token OAuth solo incluye scopes que hayan sido solicitados por ChatGPT y que existan en la lista soportada por el MCP. OAuth no decide permisos sobre datos de workspace; cada tool valida el scope especifico dentro de `financeWorkspaces/{workspaceId}/members/{firebaseUid}.grantedScopes`.

## Finanzas personales pro

La etapa 1 permite:

- Registrar gastos.
- Registrar ingresos.
- Registrar transferencias.
- Consultar movimientos por rango de tiempo.
- Manejar workspaces.
- Manejar miembros y permisos por workspace.
- Manejar categorias controladas por workspace.
- Manejar cuentas.
- Manejar metodos de pago dentro de cuentas.
- Ajustar saldos con movimiento de auditoria.

Tipos de workspace:

```txt
personal
household
business
```

`personal` es para finanzas individuales, `household` para casa/familia/pareja con finanzas compartidas y `business` para negocio o microempresa.

## Tools MCP

```txt
create_workspace
list_workspaces
add_workspace_member
list_workspace_members
list_categories
upsert_category
upsert_account
list_accounts
upsert_payment_method
list_payment_methods
create_expense
create_income
create_transfer
set_account_balance
list_movements
```

Las tools de escritura actualizan saldos dentro de una transaccion Firestore y crean registros de idempotencia.

`list_movements` devuelve una pagina de resultados. La respuesta incluye:

```txt
pagination.hasMore
pagination.nextCursor
```

Si `hasMore` es `true`, el agente debe explicar que hay mas movimientos disponibles y preguntar si el usuario quiere ver la siguiente pagina. Para continuar, debe llamar `list_movements` con los mismos filtros y `cursor=nextCursor`.

## Miembros y permisos por workspace

Los miembros viven en:

```txt
financeWorkspaces/{workspaceId}/members/{firebaseUid}
```

Cada miembro guarda:

```txt
role
status
grantedScopes
```

`financeWorkspaces/{workspaceId}/members/{firebaseUid}.grantedScopes` controla lo que ese usuario puede hacer en ese workspace. Para bloquear a un usuario en un workspace se puede dejar ese array vacio o marcar el miembro como `inactive`.

Para agregar miembros:

1. La persona debe haber conectado el MCP con Google al menos una vez para existir como `users/{firebaseUid}`.
2. El owner o administrador llama `add_workspace_member`.
3. Se indica `memberEmail` o `memberUserId`.
4. Se indica `role`: `viewer`, `member` o `admin`.
5. La tool convierte ese rol a `grantedScopes`, actualiza `financeWorkspaces/{workspaceId}/members/{firebaseUid}` y agrega el workspace en `users/{firebaseUid}.profiles.finance.workspaceIds`.

Roles:

```txt
viewer -> solo lectura
member -> lectura y escritura financiera, sin administrar miembros
admin -> todas las tools del workspace, incluyendo administracion de miembros
```

## Categorias

Las categorias son catalogo controlado por workspace:

```txt
financeWorkspaces/{workspaceId}/categories/{categoryId}
```

Campos principales:

```txt
name
normalizedName
type
description
active
```

Tipos iniciales:

```txt
expense
income
both
```

El agente no debe inventar categorias al registrar gastos o ingresos. Debe usar `categoryId` o `categoryName` de una categoria existente. Si la categoria no existe, debe llamar `list_categories`, mostrar opciones al usuario y preguntar si quiere crear una categoria nueva con `upsert_category`.

## Cuentas y metodos de pago

Las cuentas representan contenedores de saldo:

```txt
bank
cash
wallet
credit_card
investment
loan
other
```

Los metodos de pago son subcolecciones dentro de cuentas:

```txt
financeWorkspaces/{workspaceId}/accounts/{accountId}/paymentMethods/{paymentMethodId}
```

Tipos iniciales:

```txt
debit_card
credit_card
cash
bank_transfer
spei
wallet_balance
other
```

Si el usuario dice "saque $1,000 del cajero de BBVA", el agente debe modelarlo como transferencia de BBVA a una cuenta de tipo `cash`, por ejemplo Efectivo.

## Movimientos

Todos los registros financieros viven en:

```txt
financeWorkspaces/{workspaceId}/movements/{movementId}
```

Tipos:

```txt
expense
income
transfer
balance_adjustment
```

Cada movimiento guarda `amountMinor` para evitar errores decimales y `amount` para lectura. Tambien guarda `lines` con impactos por cuenta:

```js
[
  {
    accountId: '...',
    accountName: 'BBVA',
    amountMinor: -200000,
    amount: -2000,
    direction: 'outflow'
  }
]
```

## Comportamiento esperado del agente

Antes de llamar una tool de escritura, ChatGPT debe:

1. Extraer datos del mensaje, ticket o recibo del usuario.
2. Identificar workspace, categoria, cuenta y metodo de pago cuando aplique.
3. Llamar tools de listado si necesita resolver IDs.
4. Si la categoria no existe, pedir confirmacion antes de crearla con `upsert_category`.
5. Si la cuenta no existe, preguntar al usuario los datos de configuracion antes de crearla: nombre, tipo, moneda, institucion si aplica y saldo actual.
6. Preguntar al usuario por campos requeridos que falten o sean ambiguos.
7. Dar un resumen breve de lo que se va a registrar.
8. Llamar la tool de escritura solo cuando tenga datos suficientes.

Ejemplo de resumen:

```txt
Voy a registrar un gasto de $183.50 MXN en Oxxo, categoria comida, fecha 2026-06-25, saliendo de BBVA.
```

## Errores para agentes

Las tools deben devolver errores estructurados con:

```txt
code
message
agentAction
missingFields
suggestedTool
details
```

Ejemplos:

```txt
workspace_required -> llamar list_workspaces y pedir al usuario que elija.
account_required -> llamar list_accounts o crear cuenta con upsert_account.
category_required -> llamar list_categories y pedir al usuario que elija o confirme crear categoria.
category_not_found -> listar categorias y pedir usar una existente o crear una nueva con upsert_category.
initial_balance_required -> preguntar saldo actual de la nueva cuenta antes de crearla.
payment_method_not_found -> llamar list_payment_methods o crear metodo con upsert_payment_method.
ambiguous_account -> mostrar coincidencias y pedir al usuario que elija.
insufficient_scope -> pedir reconectar el connector con el scope requerido.
workspace_scope_denied -> avisar que el usuario no tiene permiso en ese workspace y pedir a un owner que actualice sus scopes.
```

## Idempotencia

Cada tool MCP de escritura financiera pide `idempotencyKey`. El agente debe generar una clave nueva por cada movimiento real, usando accion, fecha del movimiento, un resumen compacto y un sufijo aleatorio o de tiempo. Ejemplos:

```txt
expense:2026-06-26:oxxo-cafe:8f3a21
income:2026-06-26:sueldo:1720
transfer:2026-06-26:bbva-a-efectivo:9c41
```

La misma clave solo debe reutilizarse al reintentar exactamente la misma llamada por una falla tecnica. Para otro movimiento real, incluso si se parece, debe generar otra clave.

El backend acota la unicidad por accion y fecha del movimiento:

```txt
idempotencyHash = SHA-256(action + movement.date + idempotencyKey)
```

Y lo guarda en:

```txt
financeWorkspaces/{workspaceId}/idempotencyKeys/{idempotencyHash}
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
/mcp/finance
/.well-known/oauth-protected-resource
/.well-known/oauth-authorization-server
/oauth/authorize
/oauth/token
/oauth/register
/api/ping
```
