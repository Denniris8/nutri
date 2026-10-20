# 🏃 Garmin Query CLI

Herramienta de línea de comandos para consultas rápidas de datos de Garmin Connect.

## Instalación

El CLI ya está configurado en el proyecto. Solo necesitas tener las credenciales en `.env`:

```bash
GARMIN_EMAIL="tu@email.com"
GARMIN_PASSWORD="tu_password"
```

## Uso

```bash
npm run query <comando>
```

## Comandos Disponibles

| Comando | Descripción |
|---------|-------------|
| `activities` | Últimas 10 actividades |
| `today` | Resumen del día de hoy |
| `week` | Resumen de la semana (últimos 7 días) |
| `sleep` | Últimos 7 días de sueño |
| `weight` | Últimos registros de peso (30 días) |
| `stats` | Estadísticas generales (últimos 7 días) |
| `gym` | Últimas sesiones de gimnasio (30 días) |
| `help` | Muestra la ayuda |

## Ejemplos

### Ver actividades recientes
```bash
npm run query activities
```

**Salida:**
```json
[
  {
    "fecha": "2026-04-27",
    "tipo": "walking",
    "duracion_min": 41,
    "distancia_km": "3.7",
    "calorias": 245,
    "hr_prom": 107
  },
  {
    "fecha": "2026-04-26",
    "tipo": "strength_training",
    "duracion_min": 51,
    "distancia_km": "-",
    "calorias": 391,
    "hr_prom": 132
  }
]
```

### Resumen del día de hoy
```bash
npm run query today
```

**Salida:**
```json
{
  "fecha": "2026-04-28",
  "pasos": 8675,
  "calorias": 2204,
  "hr_reposo": 49,
  "estres": 28,
  "intensidad_mod": 8,
  "intensidad_vig": 0
}
```

### Estadísticas de la semana
```bash
npm run query stats
```

**Salida:**
```json
{
  "dias_analizados": 7,
  "pasos_promedio": 9061,
  "calorias_promedio": 2468,
  "hr_reposo_promedio": 52,
  "estres_promedio": 30
}
```

### Sesiones de gimnasio
```bash
npm run query gym
```

**Salida:**
```json
[
  {
    "fecha": "2026-04-26",
    "duracion_min": 51,
    "calorias": 391,
    "hr_promedio": 132,
    "hr_maxima": 160,
    "series": 1
  },
  {
    "fecha": "2026-04-25",
    "duracion_min": 55,
    "calorias": 384,
    "hr_promedio": 124,
    "hr_maxima": 162,
    "series": 1
  }
]
```

### Datos de sueño
```bash
npm run query sleep
```

**Salida:**
```json
[
  {
    "fecha": "2026-04-27",
    "total_h": "7.2",
    "deep_h": "1.5",
    "light_h": "4.8",
    "rem_h": "0.9",
    "score": 85
  }
]
```

### Evolución de peso
```bash
npm run query weight
```

**Salida:**
```json
[
  {
    "fecha": "2026-04-27",
    "peso_kg": 82.4,
    "bmi": 28.5,
    "grasa_pct": 30.0,
    "musculo_pct": 33.5
  },
  {
    "fecha": "2026-04-20",
    "peso_kg": 82.3,
    "bmi": 28.5,
    "grasa_pct": 28.0,
    "musculo_pct": 34.7
  }
]
```

## Usar en Scripts

Puedes usar la salida JSON en otros scripts:

```bash
# Guardar actividades en archivo
npm run query activities > actividades.json

# Procesar con jq
npm run query today | jq '.pasos'

# Usar en Python
npm run query week | python3 -c "import sys, json; data = json.load(sys.stdin); print(f'Promedio pasos: {sum(d[\"pasos\"] for d in data)/len(data)}')"
```

## Personalizar Consultas

Puedes agregar tus propias consultas editando `query.ts`. Cada consulta tiene esta estructura:

```typescript
'mi_consulta': {
  desc: 'Descripción de la consulta',
  fn: async () => {
    // Tu código aquí usando client
    const data = await client.getDailySummary('2026-04-28');
    return { /* tus datos formateados */ };
  }
}
```

## Notas

- Todas las consultas requieren autenticación con Garmin Connect
- Los datos se obtienen en tiempo real (no hay caché)
- Las fechas están en formato ISO (YYYY-MM-DD)
- La salida siempre es JSON válido (puedes usarla con `jq`, Python, etc.)
- Los mensajes de progreso van a `stderr`, la salida JSON va a `stdout`
