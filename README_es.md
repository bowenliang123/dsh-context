![Vista previa social](https://raw.githubusercontent.com/bowenliang123/dsh-context/main/docs/social-preview.png)

# dsh-context

[简体中文](https://github.com/bowenliang123/dsh-context/blob/main/README.md) · [English](https://github.com/bowenliang123/dsh-context/blob/main/README_en.md) · [日本語](https://github.com/bowenliang123/dsh-context/blob/main/README_ja.md) · [Español](https://github.com/bowenliang123/dsh-context/blob/main/README_es.md) · [Français](https://github.com/bowenliang123/dsh-context/blob/main/README_fr.md) · [Deutsch](https://github.com/bowenliang123/dsh-context/blob/main/README_de.md) · [Русский](https://github.com/bowenliang123/dsh-context/blob/main/README_ru.md) · [Português](https://github.com/bowenliang123/dsh-context/blob/main/README_pt.md)

[![versión de npm](https://img.shields.io/npm/v/dsh-context)](https://www.npmjs.com/package/dsh-context)
[![estrellas de GitHub](https://img.shields.io/github/stars/bowenliang123/dsh-context?style=social)](https://github.com/bowenliang123/dsh-context)
[![dshfind](https://dshfind.com/api/badge/bowenliang123/dsh-context)](https://dshfind.com/en/plugins/bowenliang123/dsh-context?ref=badge)

**El mejor [plugin de DeepSeek Harness](https://www.deepseek.com/harness/) para el análisis y la gestión del contexto del agente.**

> Recomendado y marcado con una estrella por [@tianyicui](https://github.com/tianyicui) y [@turtle1999](https://github.com/turtle1999), del equipo de DeepSeek Harness; consulta [esta publicación en X](https://x.com/tianyi/status/2105256532657267119).

[`dsh-context`](https://www.npmjs.com/package/dsh-context) ofrece funciones completas de gestión del ciclo de vida del contexto.
- **Página Análisis del contexto**: la vista general entre sesiones como panel de primer nivel en la barra lateral (junto a Plugins y Tareas de automatización): banda de KPI con un gráfico de uso de tokens y coste de 7 días, mapa de calor de actividad, anillo de composición agregada y tarjetas de sesión filtrables que abren directamente cualquier sesión.
- **Pestaña Contexto**: un panel de contexto con estadísticas, composición, tendencias, eventos, mensajes y comandos de DeepSeek Harness.
- **Pestaña Flota**: la página propia de la familia de agentes: el agente actual, sus padres y todos los subagentes, cada uno con una tarjeta en vivo.
- **Panel Contexto**: el mismo panel como pestaña de la barra lateral derecha: selecciona **Contexto** en la página de guía de la barra lateral y el panel se abre junto al chat, incluida la red de agentes.
- **Comando `/context`**: el comando de barra diagonal muestra el modelo de contexto para la composición actual y la evolución reciente del contexto.

▶️ **Vídeo explicativo de 4 minutos**: [ver en Bilibili](https://www.bilibili.com/video/BV1bn4K6TEEV/) (en chino).

[![dsh-context y DeepSeek Harness: composición del contexto, evolución y equipos multiagente](https://raw.githubusercontent.com/bowenliang123/dsh-context/main/docs/video-cover.jpg)](https://www.bilibili.com/video/BV1bn4K6TEEV/)

## Instalación / actualización

### Instalar en DeepSeek Harness web o de escritorio

Escribe `dsh-context` en el cuadro de búsqueda del asistente **Añadir plugin** y haz clic en **Instalar**:

![Asistente para añadir plugins](https://raw.githubusercontent.com/bowenliang123/dsh-context/main/docs/add-plugin-wizard.png)

### Instalar con la CLI de `dsh`

Instala el plugin [`dsh-context`](https://www.npmjs.com/package/dsh-context) desde [DeepSeek Harness](https://www.npmjs.com/package/@deepseek-ai/dsh):

```sh
dsh plugin --profile web add dsh-context
```

O actualiza el plugin `dsh-context`:

```sh
dsh plugin --profile web update dsh-context@latest
```

Después, inicia la interfaz web con `dsh web`. Sin compilación ni reinicio.

## Uso

Cinco superficies, una misma historia: qué lleva tu agente, cómo llegó ahí y qué hizo con ello:

| Dónde | Qué obtienes |
| --- | --- |
| **Página Análisis del contexto** | Todas las sesiones de un vistazo: uso, coste, aciertos de caché, actividad diaria y perfiles de contexto por sesión, filtrados por intervalo, día, grupo o búsqueda, con un clic para entrar. |
| **Pestaña Contexto** | El panel completo: estadísticas, composición, tendencia por solicitud, eventos, actividad de archivos y ejecuciones de comandos, en cada sesión. |
| **Pestaña Flota** | La red de agentes: el agente actual, sus padres y todos los subagentes, en vivo. |
| **Comando `/context`** | Un modal centrado con la misma composición y el mismo explorador de contexto, sin salir del chat. |
| **Tarjeta de preferencias** | Valores predeterminados por usuario: la entrada del panel, el intervalo de Análisis del contexto, las opciones de tendencia y orden, y el prefijo/sufijo del prompt del sistema que se añade a cada sesión. |

## 🗂️ La página Análisis del contexto

Haz clic en **Análisis del contexto** en la lista de paneles de la barra lateral, al mismo nivel que **Plugins** y **Tareas de automatización**, y la página se abre como un panel completo en la columna central:

![La página Análisis del contexto](https://raw.githubusercontent.com/bowenliang123/dsh-context/main/docs/context-dashboard.png)

| Sección | La pregunta que responde |
| --- | --- |
| **Banda de KPI** | Cuánto estoy usando: sesiones activas en el intervalo seleccionado (7 d / 30 d / todo), con tokens facturados, coste estimado, tasa de aciertos de caché y turnos agregados por el día en que comenzó cada paso; las ejecuciones de herramientas y el tiempo activo abarcan toda la vida de esas sesiones y de sus subagentes, igual que la tarjeta de tiempo. |
| **Gráfico de uso de 7 días** | Cuánto gasté y cuándo: los tokens facturados y el coste estimado de cada uno de los últimos 7 días como un par de barras, agregados por el día de inicio de cada solicitud en su sesión, no el último día activo de la sesión. |
| **Mapa de calor de actividad** | Cuándo trabajo realmente: los tokens facturados diarios de las últimas 8 semanas; haz clic en un día para filtrar las sesiones y limitar las tres tarjetas de totales a ese día. |
| **Cargas de habilidades** | Qué habilidades cargué, con qué frecuencia y cuándo fue la última vez: las cargas por habilidad del intervalo; haz clic en una para filtrar las sesiones que la cargaron. |
| **Llamadas a herramientas** | Qué herramientas se ejecutaron, con qué frecuencia y cuándo fue la última vez: las ejecuciones por herramienta del intervalo según el registro diario; haz clic en una para filtrar las sesiones que la ejecutaron. |
| **Ejecuciones de comandos** | Qué programas se ejecutaron, con qué frecuencia y cuándo fue la última vez: las ejecuciones de comandos por programa del intervalo, contabilizadas al enviarse; haz clic en uno para filtrar las sesiones que lo ejecutaron. |
| **Entrada de configuración** | El chip del encabezado de la página: el mismo salto protegido a las preferencias de este plugin que la tarjeta Información del plugin de la pestaña Contexto. |
| **Composición del contexto** | Adónde fueron los tokens facturados del intervalo seleccionado, divididos por las categorías facturadas de la tarjeta Tokens: Llamadas a herramientas, Razonamiento, Respuestas, etc. |
| **Tarjetas de sesión** | El perfil de cada sesión bajo las cuatro tarjetas: anillo de composición, tokens facturados, turnos, coste y su ruta de grupo de espacio de trabajo / proyecto; ordenadas por recencia, tokens o tamaño del contexto, con búsqueda y agrupación por espacio de trabajo. Haz clic en una tarjeta para abrir la sesión. |


## 📊 La pestaña Contexto

Abre cualquier sesión y haz clic en la pestaña **Contexto**:

![Vista general del panel Contexto](https://raw.githubusercontent.com/bowenliang123/dsh-context/main/docs/context-overview.png)

| Tarjeta | La pregunta que responde |
| --- | --- |
| **Estadísticas del contexto** | Turnos, pasos, entradas humanas y llamadas a herramientas en vivo, además de un coste estimado a partir de los precios de models.dev; pasa el cursor por `?` para ver las tarifas por millón. Solo DeepSeek distingue entre horas punta y de baja demanda: sus tarifas indicadas corresponden a las de baja demanda y las horas punta se facturan al doble. |
| **Estadísticas de tokens** | Adónde fueron los tokens facturados: el mismo total que la línea de estadísticas del chat bajo el editor, dividido en Prompt del sistema, Esquemas de herramientas, Mensajes del usuario, Contexto inyectado, Inyecciones de habilidades, Llamadas a herramientas, Razonamiento y Respuestas. Llamadas a herramientas combina los nombres y argumentos de las llamadas, reproducidos en el prompt y generados en la salida, con los resultados devueltos por esas herramientas; Respuestas separa el texto de las respuestas del modelo del mismo contenido y salida del asistente; Razonamiento separa su pensamiento del mismo modo; la tasa de aciertos de caché de la sesión aparece en la esquina. |
| **Estadísticas de tiempo** | Cómo se dividió el tiempo activo entre llamadas al modelo, ejecuciones de herramientas y sobrecarga. |
| **Contexto actual** | Qué hay en la ventana *ahora mismo*. |
| **Tendencia del contexto** | El tamaño de cada solicitud y su historia. |
| **Explorador de contexto** | Con qué se ensambló *realmente* cualquier solicitud. |
| **Eventos de contexto** | Cuándo y por qué cambió la ventana. |
| **Actividad de archivos** | Qué *hizo* el agente con tus archivos. |
| **Ejecuciones de comandos** | Qué ejecutó el agente, cómo terminó cada ejecución y en qué programas más confió. |

La estimación de coste sigue un único conjunto documentado de reglas: [Cómo se asignan los precios de los modelos](docs/model-pricing-mapping.md).

Las cifras principales de ocupación y composición leen las **mismas proyecciones oficiales del medidor de tokens que el anillo de contexto del editor del chat** (`contextPressure` / `contextBreakdown`), por lo que siempre coinciden con lo que indica el anillo; el porcentaje de la tarjeta es esa misma ocupación, con un decimal.

La celda Red de agentes de la tarjeta **Estadísticas del contexto**, con los tokens facturados y el coste estimado de toda la familia, salta a la pestaña **Flota**. Sus botones de Entrada / Salida también son enlaces: **Entradas humanas** abre el **Explorador de contexto** en tus mensajes, y **Lectura / Escritura / Búsqueda / Imágenes** abren la tarjeta **Actividad de archivos** con ese tipo seleccionado.

### Estadísticas del contexto

#### Estadísticas de tokens y de tiempo
![Estadísticas_de_tokens_y_de_tiempo](https://raw.githubusercontent.com/bowenliang123/dsh-context/main/docs/token-stats-and-timing-stats.png)

#### Estadísticas del contexto
![Estadísticas_del_contexto](https://raw.githubusercontent.com/bowenliang123/dsh-context/main/docs/context-stats.png)


### 🧱 Contexto actual: qué hay ahora en la ventana de contexto

![Tarjeta Contexto actual](https://raw.githubusercontent.com/bowenliang123/dsh-context/main/docs/current-context.png)

Una barra apilada de seis colores sobre la ventana completa del modelo (las dos máscaras rayadas del final = la reserva de compactación automática: su margen y luego la ventana de salida reservada de la solicitud): prompt del sistema, esquemas de herramientas, mensajes del usuario, contexto inyectado, respuestas del asistente y resultados de herramientas, cada uno con su cifra aproximada de tokens y su proporción. Cuando una conversación empieza a degradarse, aquí ves *qué parte* es responsable.

### 📈 Tendencia del contexto: cómo creció y evolucionó el contexto por turnos o pasos

![Tendencia del contexto con el resumen del paso](https://raw.githubusercontent.com/bowenliang123/dsh-context/main/docs/context-trend.png)

Una barra apilada por solicitud al modelo, más detallada que por mensaje, para ver crecer la ventana turno a turno:

- **✨ Resumen del paso**: tres filas en lenguaje sencillo bajo el gráfico: **Usuario** recupera el mensaje que abrió el turno, **Entrada** enumera lo que acaba de entrar, normalmente los resultados de herramientas anteriores, y **Respuesta** muestra la respuesta o las herramientas llamadas. Haz clic en una fila para abrir ese mensaje exacto en el Explorador de contexto.
- **✂ señala los eventos**: las compactaciones y podas se fijan a la barra donde ocurrieron, de modo que las caídas se explican por sí solas.
- **Léelo como prefieras**: granularidad **Paso / Turno**, **Total** (composición acumulada) o **Delta** (cambio con signo de cada solicitud), y desplazamiento lateral por toda la sesión. En modo Delta, el crecimiento se apila sobre la línea base y una compactación cae por debajo:

![Tendencia del contexto en modo Delta](https://raw.githubusercontent.com/bowenliang123/dsh-context/main/docs/history-delta.png)

- **Vista general**: un conmutador comprime toda la sesión, por pasos o turnos, al ancho del panel como una cinta apilada continua: cada caída por compactación y cada cambio de composición de un vistazo, sin desplazamiento lateral ni cargas adicionales. Las marcas señalan los cuartiles y el intervalo completo; desplaza el cursor para recorrerla y pásalo por una banda para resaltar esa categoría en toda la cinta; haz clic para fijar el paso y abrir la categoría de esa banda en el explorador. Es excluyente con el modo DNA y Adaptativo.
- **Pasar el cursor y fijar**: desplázalo para ver un tooltip instantáneo; haz clic para fijar el desglose completo, con **Prompt / Salida / Caché reales** informados por el proveedor junto a las estimaciones.
- **Vinculación en vivo**: al pasar el cursor por una barra se muestra una vista previa del contexto ensamblado de ese paso en el Explorador de contexto junto al gráfico; al salir del gráfico vuelve tu propia selección.

### 🧭 Explorador de contexto: abre la caja de cualquier solicitud

Elige **En vivo (próxima solicitud)** o cualquier paso conservado, y explora con qué se ensambló esa solicitud: siete categorías plegables se expanden en una fila por elemento con su coste en tokens, y cada elemento vuelve a expandirse en su **contenido real**: el prompt del sistema, el esquema JSON de cada herramienta, el texto de los mensajes, el razonamiento, los argumentos de herramientas y sus salidas. El contenido de habilidades, incluidos el catálogo de habilidades disponibles, las invocaciones de `/skill` y las cargas de la herramienta `skill`, tiene su propia categoría **Inyecciones de habilidades**, para que la huella de contexto de una habilidad sigilosa no pueda ocultarse entre el contexto inyectado y los resultados de herramientas.

- **Quién proporciona cada herramienta**: cada fila de esquema de herramienta incluye una etiqueta de origen obtenida con la mayor precisión posible: paquetes propios `tool-*`, paquetes de capacidades `dsh-*`, proxies `mcp:<server>` o el plugin exacto observado en vivo desde `tools.register()`. Ordena por **tamaño / nombre** y filtra cada categoría por sus propios campos de búsqueda:

![Esquemas de herramientas con etiquetas de origen, filtro y orden](https://raw.githubusercontent.com/bowenliang123/dsh-context/main/docs/context-browser-tools.png)

- **Filtra las respuestas del asistente por tipo**: el cuadro de búsqueda de la categoría del asistente incluye los chips **Razonamiento / Herramientas / Respuesta**, cada uno con el número de respuestas de ese tipo en los resultados de búsqueda actuales; una respuesta puede incluir varios. Haz clic en uno para conservar solo las respuestas coincidentes y haz clic de nuevo para quitar el filtro:

![Respuestas del asistente con chips de filtro por tipo](https://raw.githubusercontent.com/bowenliang123/dsh-context/main/docs/context-browser-assistant-kinds.png)

- **Los resultados de herramientas se abren en la llamada completa**: el nombre y los argumentos de la herramienta con su estado **OK/error**, el cuerpo del resultado con el número de líneas y un conmutador **Sin formato / Markdown**:

![Un resultado de herramienta expandido con el conmutador Sin formato/Markdown](https://raw.githubusercontent.com/bowenliang123/dsh-context/main/docs/context-browser-tool-result.png)

- **Los adjuntos se muestran como tarjetas ordenadas**: los bloques `image` y `file` de un mensaje aparecen juntos en el orden que lleva el mensaje, una tarjeta por bloque: imágenes con miniatura, dimensiones, tamaño almacenado y la estimación oficial de tokens de imagen de DeepSeek; otros archivos con su glifo de tipo, extensión y tamaño almacenado. Un clic abre el adjunto en la columna de vista previa propia de dsh, con visores de Markdown, código, PDF, Office e imágenes, bajo el nombre real del archivo:

![Tarjetas de adjuntos de imagen con dimensiones, tamaño almacenado y estimación de tokens](https://raw.githubusercontent.com/bowenliang123/dsh-context/main/docs/context-browser-images.png)

- **Comparación con el turno anterior**: las insignias de delta con signo por categoría, `+N` elementos y `±Nk` tokens, muestran de un vistazo qué añadió o recuperó un turno. Los pasos anteriores a una compactación se reconstruyen a partir del archivo de mensajes eliminados, y la tarjeta lo indica cuando la composición de un paso solo es aproximada.

- **El modo DNA despliega todo el contexto en una lista plana**: la barra dibuja una banda por elemento en el orden de lectura del modelo y, debajo, esos mismos elementos forman una lista plana con el mensaje más reciente arriba; el modelo lee del más antiguo al más reciente, por lo que la lista invierte ese orden. Cada fila lleva su posición en el prompt (`#12`), categoría, paso que la introdujo y coste en tokens, y se expande en el mismo contenido completo; los esquemas de herramientas y el prompt del sistema cierran la lista como dos filas de grupo. La tarjeta termina alineada con las tarjetas de composición y tendencia que tiene al lado; una sesión completamente desplegada se desplaza dentro de ella en lugar de inundar la página.

### ⚡ Eventos de contexto: cuándo y por qué cambió la ventana

![Eventos de contexto con una compactación](https://raw.githubusercontent.com/bowenliang123/dsh-context/main/docs/context-events.png)

Cada inyección, compactación, poda, cambio de modelo y activación o desactivación del modo de planificación, etiquetada con su productor (archivo de instrucciones, id de plugin, nombre de habilidad), su delta neto de tokens (las compactaciones muestran lo que recuperaron), turno/paso y hora. Los chips **Inyectar / Compactar / Podar / Cambiar / Modo** filtran el registro por tipo y cada uno lleva su total de eventos de toda la sesión.

### 📁 Actividad de archivos: qué hizo el agente con tus archivos

![Actividad de archivos](https://raw.githubusercontent.com/bowenliang123/dsh-context/main/docs/file-activity.png)

Una fila por archivo tocado, leído, escrito o buscado, agregada hasta el paso que elijas en el gráfico de tendencias:

- **Recuentos por finalidad** con chips de encabezado que también sirven como filtros (**Lectura / Escritura / Búsqueda / Imágenes**) y un cuadro de búsqueda por ruta.
- **Deltas de líneas**: cada `edit`/`write` aporta su huella estimada de `+líneas añadidas / −líneas eliminadas`, por archivo y sumada.
- **Todos los modos cuentan**: las herramientas nativas, el `str_replace_editor` del preset Minimal y las llamadas anidadas dentro de programas `run_code` de PTC se integran en las filas por herramienta.
- **Las búsquedas llegan a archivos reales**: los archivos coincidentes obtienen sus propias filas de operaciones con recuentos de coincidencias.
- **Haz clic en una fila** para expandir su registro completo de operaciones; cada operación salta directamente al resultado exacto de la herramienta en el Explorador de contexto.
- **Haz clic en un nombre de archivo** para abrir su vista previa en la barra lateral derecha, exactamente como hace la barra lateral Archivos integrada: el mismo visor y el mismo comportamiento de una pestaña por archivo. En un harness sin esa columna, el nombre se abre en tu sistema como antes.

### 🖥️ Ejecuciones de comandos: qué ejecutó el agente

![Ejecuciones de comandos](https://raw.githubusercontent.com/bowenliang123/dsh-context/main/docs/command-executions.png)

Cada ejecución de shell o código con su estado, tiempo transcurrido y marca de paso, además de un resumen de sesión, accesos a aspectos destacados y una clasificación de programas. Los datos destacados y la clasificación abarcan toda la sesión mientras los chips de búsqueda y estado reducen la lista. Cada clic en el carril escribe su perspectiva en el cuadro de búsqueda: un clic en un programa introduce y resalta el programa, y otro clic borra ambos, de modo que el cuadro siempre muestra qué está filtrando la lista.

## 🚢 La pestaña Flota

Abre cualquier sesión y haz clic en la pestaña **Flota** (a la derecha de **Contexto**) — la familia de agentes en una página propia: una banda de resumen, las tarjetas **Red de agentes** y **Colaboración entre agentes**, y debajo **Tareas colaborativas** e **Inspección de eventos**.

![La página Flota de un equipo de seis agentes: resumen de la flota, Red de agentes, Colaboración entre agentes, Tareas colaborativas e Inspección de eventos](https://raw.githubusercontent.com/bowenliang123/dsh-context/main/docs/fleet-overview.png)

La banda de resumen cuenta agentes, agentes en ejecución, elementos de trabajo y mensajes. Al elegir un agente en el grafo o en un carril, la vista de colaboración se limita a ese agente, así que la página responde por un miembro a la vez.

### 🕸 Red de agentes — el retrato de la familia

El agente actual, sus padres y cada subagente — una tarjeta por agente: su título, el tamaño del contexto en vivo y la ocupación de la ventana, una barra de composición, y cuánto lleva ejecutándose y cuántos pasos ha dado. Las aristas salen de cada padre en el color del linaje — pasa el ratón por una tarjeta para iluminar toda su cadena y leer el desglose completo en la franja de detalles; haz clic en un nodo para resaltarlo. Los agentes en ejecución respiran con un pulso verde en su arista entrante y giran el propio indicador rotativo del harness junto a su título, que se asienta en el mismo punto verde que usa la lista de subagentes de la cabecera cuando el trabajo termina; las ventanas estrechas pliegan la familia en filas ordenadas — nunca una barra de desplazamiento horizontal.

### 🛰 Colaboración entre agentes — la familia en una sola línea de tiempo

Cada agente recibe un carril en una sola línea de tiempo: mensajes entre agentes, marcadores de tareas del equipo y registros de delegación, con los carriles tranquilos plegados tras un interruptor. Los números de tarea identifican una tarea entre carriles — los números repetidos son la misma tarea — y al pasar el ratón se enlazan los registros que van juntos. **Earliest / Latest** invierte el orden, el buscador estrecha los carriles y al hacer clic en una tarea se filtra la línea de tiempo y se revela.

### ✅ Tareas colaborativas — quién hace qué

El tablero **Tareas colaborativas** reúne las tareas del equipo y las delegaciones a subagentes — grupos por propietario, filtros de estado (Todas / En curso / Pendientes / Hechas) y enlaces de bloqueo que iluminan toda la cadena de requisitos al enfocar una tarea. Cada tarjeta lleva su propietario, resumen, ámbitos de escritura y respuesta final; haz clic en una tarea para abrir su descripción completa en el sitio, en bruto o renderizada.

### 📡 Inspección de eventos — quién dijo qué a quién

La tarjeta **Inspección de eventos** lee los registros de sesión de la familia automáticamente — sin paso de escaneo. Mensajes, informes y registros de delegación se filtran en un solo flujo: selecciona un nodo de la línea de tiempo o un registro del flujo para ver el registro completo — el registro de sesión del que procede y su secuencia, un aviso cuando el runtime escribió el cierre en lugar del hijo, el informe de cierre completo (con su resultado estructurado o diagnóstico), y tarjetas de participantes que abren el chat de ese agente en la barra lateral o en la vista completa. Filtra por tipo o texto, y la selección compartida de agente estrecha todo el centro.

El panel **Contexto** de la barra lateral derecha mantiene la misma tarjeta en línea, así que la familia sigue a un clic mientras lees el chat. ¿No quieres la pestaña? Desactiva **Pestaña Flota** en la tarjeta de preferencias — la tarjeta seguirá viviendo en ese panel, y la celda de familia de la pestaña Contexto la abrirá allí siempre que haya una barra lateral.

## ⌨️ Comando `/context`

Escribe `/context` (o elígelo en el menú `/`) y pulsa Intro:

![Menú de barra diagonal con el comando de contexto](https://raw.githubusercontent.com/bowenliang123/dsh-context/main/docs/context-command-entry.png)

Se abre un diálogo centrado con la tarjeta **Composición actual** y el **Explorador de contexto**: la misma barra de composición, selector por paso e insignias de comparación `contra el turno anterior` que la pestaña:

![El modal /context](https://raw.githubusercontent.com/bowenliang123/dsh-context/main/docs/context-command.png)

## ⚙️ Configuración

La tarjeta de preferencias **Contexto** contiene la configuración por usuario de este plugin: la **Entrada del panel de contexto** (la pestaña de conversación **Contexto**, el panel de la barra lateral derecha, ambos u Ocultar para ninguno; el salto de la fila de respuestas la acompaña), el conmutador Mostrar/Ocultar propio de la pestaña **Flota** (la entrada del panel nunca la condiciona), el intervalo predeterminado de **Análisis del contexto** (Hoy / Últimos 7 días / Últimos 30 días / Todo; Últimos 30 días si no se cambia; elegir un preset en la página lo guarda), la granularidad de la tendencia (Paso/Turno), el modo de tendencia (Total/Delta), la curva de duración de la tendencia (visible de forma predeterminada), el umbral de pasos para la vista general automática de la tendencia, la base de comparación del Explorador de contexto, el orden de herramientas y Actividad de archivos, y el conmutador Mostrar/Ocultar de Análisis del contexto. Está en la página **Plugins**: entrada **Plugins** de la barra lateral → página del paquete **dsh-context** → sección **Configuración**; la tarjeta la sirve el formulario Config activo de la entrada.

Las filas **Prompt del sistema · Prefijo / Sufijo** contienen texto libre que se añade justo al principio / final del prompt del sistema de cada sesión, para todos los agentes, incluidos los subagentes: una persona o regla de comportamiento por despliegue que acompaña al ensamblaje de prompts propio del harness. Los cambios se aplican a partir del siguiente turno; deja una fila vacía para desactivarla.

Los botones de preset de Análisis del contexto guardan la selección como valor predeterminado; todos los demás conmutadores de gráficos y tarjetas permanecen por vista y nunca sobrescriben la preferencia almacenada.

![La tarjeta de configuración de Contexto](https://raw.githubusercontent.com/bowenliang123/dsh-context/main/docs/settings.png)

## Conviene saber

- **Huella de caché**: el plugin solo guarda puntos de control con un resumen compacto por sesión (composición, recuentos, coste/tiempo e información del modelo) en la caché de proyecciones de dsh; los detalles pesados por evento (texto de superficie, desgloses de solicitudes, operaciones de archivos, programas de comandos e intervalos) se reconstruyen a partir del registro persistente cuando un panel los necesita, de modo que la caché sigue siendo pequeña incluso en sesiones largas. Las vistas de detalle están limitadas (pasos 1500 · turnos 300 · eventos 400 · nodos de superficie 2000 · archivo 400 · operaciones de archivos 400 · comandos 400).
- **Estimaciones y valores reales**: las cifras por categoría usan la heurística de densidad fija propia de dsh, la misma que su medidor de tokens integrado; los detalles fijados de la tendencia muestran los valores reales informados por el proveedor junto a ellas, y la tarjeta Tokens combina sus proporciones de composición estimadas con ≈ y el total facturado exacto del proveedor.
- **Compatibilidad**: funciona con `@deepseek-ai/dsh` desde **0.2.0-rc.2** (las líneas `0.2.0` y `0.2.1` verificadas en sus versiones rc.2, y la línea `0.2.2` en su versión rc.1), la generación V4 del registro de sesiones, desde una única ruta de código orientada por la forma. La matriz por versión y cómo se verifica: [docs/compatibility.md](docs/compatibility.md).
- **I18n**: interfaz en chino simplificado, inglés, japonés, español, francés, alemán, ruso y portugués (cambiar de idioma requiere dsh 0.2.2+; las líneas admitidas anteriores solo ofrecen chino e inglés).

## ¿Te gusta?

Si `dsh-context` te ayudó a comprender qué lleva tu agente, agradecemos mucho una ⭐ en [GitHub](https://github.com/bowenliang123/dsh-context); ¡las incidencias y las PR son bienvenidas!

## Licencia

[Apache-2.0](https://www.apache.org/licenses/LICENSE-2.0)
