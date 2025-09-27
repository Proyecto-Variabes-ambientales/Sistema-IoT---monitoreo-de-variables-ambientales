# Sistema-IoT---monitoreo-de-variables-ambientales
Panel web y firmware para un sistema de monitoreo de calidad del aire basado en Wemos D1 R32, con el uso de los sensores SCD40 (CO2, temperatura, humedad) y MPM10-AG (PM1.0/PM2.5/PM10). Los datos se almacenan en Firebase Realtime Database y se visualizan en un dashboard responsivo con Chart.js filtros por rango, estado y exportación a CSV

- Envío periódico de lecturas(CO2, T, RH, PM1/2.5/10).
- Gráficas en tiempo real, promedio, máx/mín, comparacion de días y fuera de rango.
- Exportación de datos a CSV por rango de fechas.
- Autentication con Firebase Auth.
- Panel admin: registro de boards con PIN por correo.
- Limites configurables y auto-referesco

