# Muestreo GeoPDF

App web instalable (PWA) para tomar muestras de suelo georreferenciadas en el iPhone sobre mapas GeoPDF exportados desde QGIS. Funciona sin señal una vez instalada.

## Qué hace
- Abre el GeoPDF y lee su georreferencia (WGS84, /VP /Measure GEO).
- Lee del PDF las capas vectoriales que exporta QGIS: puntos de muestreo y polígonos de ambientes.
- Muestra tu posición GPS, la precisión y el ambiente donde estás parado.
- Te guía hasta cada punto (distancia y rumbo, con brújula opcional).
- Registra cada muestra con código, punto, ambiente, profundidades, observaciones, coordenadas, precisión y hora.
- Exporta CSV, KML o GeoJSON para abrir en QGIS o Excel.

## En QGIS
Al exportar el layout como PDF, tildá **Crear PDF geoespacial (GeoPDF)** e **Incluir información de entidades vectoriales**. Así la app trae los puntos y los ambientes.

Los datos quedan guardados solo en el teléfono. Exportá al terminar cada lote.
