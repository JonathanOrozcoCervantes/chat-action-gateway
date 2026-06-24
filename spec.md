# Agent Action Gateway

## Resumen del proyecto

Quiero crear un proyecto general que funcione como un puente entre ChatGPT u otros agentes de IA y mis propios sistemas internos.

La idea principal es tener una página web que pueda recibir parámetros por URL. Cuando un agente genere una URL con esos parámetros y el usuario la abra, el sistema debe interpretar esos datos, validarlos y ejecutar una acción interna, como registrar información en una base de datos o llamar a una API propia.

El proyecto debe ser general y extensible. Aunque el primer caso de uso será finanzas personales, la arquitectura debe permitir agregar más acciones en el futuro, como registrar tareas, guardar notas, crear recordatorios, guardar leads, actualizar estados o ejecutar automatizaciones personales.

Si te fijas la idea sera como una especie de "MCP" que pueda ser utilizado por agentes IA comerciales como chatgpt, debido que chatgpt no puede hacer uso de MCPs normales o ejecutar llamados a APIs propias.

---

## Objetivo principal

Crear una plataforma web sencilla que permita a un agente de IA generar enlaces accionables. Al abrir esos enlaces, el sistema debe recibir los parámetros, validarlos y ejecutar una acción específica en el backend.

Ejemplo básico:

```txt
https://mi-dominio.com/action/post/expense?amount=183.50&merchant=Oxxo&category=comida&date=2026-06-23
```

Cuando el usuario abre ese enlace, el sistema debe registrar el gasto y mostrar una página de confirmación.

La pagina web sera una pagina minimalista y si todo bien al registrar, aparecera el texto de registro exitoso e igual si hubo un error.

---

## Caso de uso inicial: Finanzas personales

El primer caso de uso será registrar gastos personales a partir de tickets, recibos o comprobantes.

### Flujo esperado
A ChatGPT se le dara un prompt donde se le indique la url base de esta pagina, que sub-urls y parametros para cada una tiene disponible (igual te pongo el ejemplo de como funcionan los MCPs, basicamente le diriamos todo lo que puede hacer y para que sirve cada URL), que dependiendo de lo que necesite hacer el usuario que debe generar una url con los parametros oculta por un ipervinculo para darle clic con algo como "dar clic para registrar"
1. El usuario manda una foto de un ticket, recibo o comprobante a ChatGPT.
2. se le pregunta al usuario que quiere hacer con el(por ejemplo registrarlo)
3. ChatGPT analiza la imagen y extrae datos relevantes.
4. ChatGPT categoriza el gasto.
5. le pregunta al usuario si quiere añadir una nota al gasto o que el la genere.
6. ChatGPT genera un enlace con los datos en la URL.
7. El usuario da clic en el enlace.
8. La página recibe los parámetros.
9. El backend valida los datos.
10. El sistema registra el gasto en la base de datos.
11. La página muestra una confirmación visual con el id de la operacion(el nombre del documento de firestore creado).

---

## Datos que debería extraer el agente para gastos

Para el caso de finanzas personales, el agente debería intentar extraer:

```txt
amount
merchant
category
date
description
paymentMethod
currency
notes
```

Ejemplo:

```txt
amount=183.50
merchant=Oxxo
category=comida
date=2026-06-23
description=Compra en Oxxo
paymentMethod=tarjeta
currency=MXN
notes=Ticket registrado desde ChatGPT
```
aqui tambien se incluyen los parametros idempotencyKey y token

---

## Ejemplo de URL generada por el agente

```txt
https://mi-dominio.com/action/expense?amount=183.50&merchant=Oxxo&category=comida&date=2026-06-23&currency=MXN&description=Compra%20en%20Oxxo&idempotencyKey=123&token=abc123
```

---

## Objetivo general del sistema

Aunque el primer caso de uso sea finanzas personales, el sistema debe estar pensado para soportar diferentes tipos de acciones.

Ejemplos futuros:

* Registrar gastos.
* Guardar notas.
* Crear tareas.
* Crear recordatorios.
* Registrar ventas.
* Guardar leads.
* Actualizar estados en una base de datos.
* Ejecutar automatizaciones personales.
* Conectar con APIs internas.
* Registrar ideas.
* Guardar eventos.
* Crear entradas en un CRM personal.
* Registrar movimientos de inventario.

---

## Estructura de rutas sugerida

El sistema debería tener una estructura general basada en acciones.

```txt
/action/:type-method(get/post/put/delete)/:type
```

Donde `type` puede representar el tipo de acción que se quiere ejecutar.

Ejemplos:

```txt
/action/get/expense
/action/post/note
/action/put/task
/action/delete/reminder
/action/get/lead
/action/post/custom
```

---

## Requisitos funcionales del MVP

El MVP debe enfocarse primero en el flujo de gastos personales.

### Funcionalidades iniciales

* Crear página `/action/expense`.
* Recibir parámetros por URL.
* Validar los campos recibidos.
* Validar un token de autorización.
* Evitar registros duplicados usando `idempotencyKey`.
* Guardar el gasto en base de datos.
* Mostrar una pantalla de éxito.
* Mostrar una pantalla de error cuando falten datos o el token sea inválido.
* Guardar logs de cada intento de acción.
* Preparar la arquitectura para agregar nuevos tipos de acciones después.


### Notas extra, la clave idempotencyKey la debe generar el agente en cuestion, en el prompt tendra las instrucciones de como lo debe generar, se me ocurre que debe ser una combinacion de cosas, ejemplo, cantidad, merchant, date si se puede con segundos, description, etc, y que con eso genere una clave unica. el token debe existir una tabla en firestore que tenga todos los tokens disponibles, un documento por token, antes de intentar registrar se debe validar que el token sea valido, y si ya existe un registro con ese idempotencyKey, se debe retornar un error indicando que el registro ya existe. en el documento que se genere al registrar un gasto se debe guardar en un campo el token usado para poder saber que token hizo ese registro.