# 🚀 Cómo subir Tutti Frutti a Render

## Archivos que tienes:
```
tutti-frutti-server/
├── server.js         ← El servidor
├── package.json      ← Dependencias
└── public/
    └── index.html    ← El juego
```

---

## PASO 1 — Subir a GitHub

1. Ve a https://github.com y crea una cuenta (si no tienes)
2. Click en **"New repository"** (botón verde)
3. Nombre: `tutti-frutti`
4. Deja todo en default → click **"Create repository"**
5. En la siguiente pantalla verás opciones. Click en **"uploading an existing file"**
6. Arrastra los 3 archivos:
   - `server.js`
   - `package.json`
   - La carpeta `public/index.html` (primero crea la carpeta manualmente en GitHub)
7. Click **"Commit changes"**

### Forma más fácil (GitHub Desktop):
- Descarga https://desktop.github.com
- Arrastra la carpeta `tutti-frutti-server` y haz push

---

## PASO 2 — Desplegar en Render

1. Ve a https://render.com y crea una cuenta (gratis con Google)
2. Click en **"New +"** → **"Web Service"**
3. Conecta tu cuenta de GitHub → selecciona el repo `tutti-frutti`
4. Configura así:

| Campo | Valor |
|-------|-------|
| Name | tutti-frutti |
| Region | Oregon (US West) |
| Branch | main |
| Runtime | Node |
| Build Command | `npm install` |
| Start Command | `npm start` |
| Instance Type | **Free** |

5. Click **"Create Web Service"**
6. Espera ~2 minutos mientras Render lo despliega
7. Te dará una URL tipo: `https://tutti-frutti-xxxx.onrender.com`

---

## PASO 3 — ¡Jugar!

Comparte esa URL con tus amigos. Cada quien:
1. Entra a la URL desde su celular o PC
2. Escribe su nombre
3. El host crea sala y comparte el código de 6 letras
4. Los demás ingresan el código y ¡a jugar!

---

## ⚠️ Nota sobre el plan gratuito de Render

El servidor gratuito se "duerme" después de 15 minutos sin uso.
La primera vez que alguien entre puede tardar ~30 segundos en despertar.
Para uso frecuente considera el plan Starter ($7/mes).

---

## 🎮 Reglas del juego

- Aparece una letra aleatoria
- Tienes que llenar las 10 categorías con palabras que empiecen con esa letra
- El primero en presionar **STOP** termina la ronda
- **10 puntos** → respuesta única
- **5 puntos** → respuesta repetida con otro jugador  
- **0 puntos** → vacío o letra incorrecta
- Gana quien más puntos acumule en todas las rondas
