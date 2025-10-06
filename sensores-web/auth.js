/* ---------------------- auth.js (comentado) ----------------------
   - Inicializa Firebase (compat)
   - Gestiona sesión (login/logout) y visibilidad de la pestaña de configuración
   - Expone `window.db` para que script.js pueda leer RTDB
------------------------------------------------------------------- */

/* 1) Configuración de tu proyecto Firebase (copiada de la consola) */
const firebaseConfig = {
  apiKey:            "AIzaSyCFU-wLb_ALd1KOTPg2FkOKfMu2VBJZY9o",
  authDomain:        "esp32-sensores-582d2.firebaseapp.com",
  databaseURL:       "https://esp32-sensores-582d2-default-rtdb.firebaseio.com",
  projectId:         "esp32-sensores-582d2",
  storageBucket:     "esp32-sensores-582d2.appspot.com",
  messagingSenderId: "1055250219131",
  appId:             "1:1055250219131:web:8c6f6649750e92d62522de"
};

/* 2) Garantiza inicializar UNA sola app (importante con SPA y recargas)
      - Si ya hay una app creada (firebase.apps.length > 0), la reutiliza.
      - Si no, crea una nueva con `initializeApp`. */
const app = (firebase.apps && firebase.apps.length)
  ? firebase.app()
  : firebase.initializeApp(firebaseConfig);

/* 3) Atajos a servicios ligados a la app actual */
const auth = app.auth();       // Firebase Authentication
const db   = app.database();   // Realtime Database

/* 4) Exponer `db` globalmente para que script.js pueda usarla
      (script.js hace un wait hasta que `window.db` exista) */
window.db = db;

/* 5) UIDs que tendrán rol de administrador (muestran la pestaña Configuración) */
const ADMIN_UIDS = [
  "YsEz5O95zjhPXXpY3adepwP54RR2",
  "l6WrtgxUA3VHGIwsxbvgQPGcquT2"
];

/* 6) Persistencia de la sesión
      - `SESSION` => la sesión vive mientras la pestaña/ventana esté abierta.
      - Si se cierra, habrá que loguearse de nuevo (evita “saltar” al dashboard
        si la persona dejó sesión abierta en otra pestaña diferente). */
auth.setPersistence(firebase.auth.Auth.Persistence.SESSION).catch(()=>{});

/* 7) Función pública para iniciar la lógica de auth en cada página
      - En login: atiende el botón, muestra errores y redirige al dashboard.
      - En dashboard: protege la ruta, rellena correo, gestiona logout
        y muestra/oculta la pestaña Configuración según el rol. */
function authInit(opts = {}) {

  /* ============ LÓGICA PARA LOGIN.HTML ============ */
  if (opts.loginPage) {
    const email    = document.getElementById("email");
    const password = document.getElementById("password");
    const msg      = document.getElementById("msg");
    const btn      = document.getElementById("btnLogin");

    // Click en “Ingresar”
    btn.addEventListener("click", async () => {
      msg.textContent = "";  // limpia mensaje previo
      try {
        // Inicia sesión con correo/contraseña (compat)
        await auth.signInWithEmailAndPassword(
          (email.value||"").trim(),
          (password.value||"").trim()
        );
        // Si no lanza error, redirige al dashboard
        location.href = "dashboard.html";
      } catch (e) {
        // Muestra mensajes mínimos y claros en español
        const code = e?.code || "";
        if (code === "auth/user-not-found")         msg.textContent = "Usuario no existe";
        else if (code === "auth/wrong-password")    msg.textContent = "Contraseña incorrecta";
        else if (code === "auth/invalid-email")     msg.textContent = "Correo inválido";
        else if (code === "auth/too-many-requests") msg.textContent = "Demasiados intentos. Intenta luego.";
        else                                        msg.textContent = "Error: " + code;
      }
    });

    // Si ya había sesión abierta en esta pestaña, entra directo al panel
    auth.onAuthStateChanged(u => { if (u) location.href = "dashboard.html"; });
    return; // Fin de la lógica de login
  }

  /* ============ LÓGICA PARA DASHBOARD.HTML ============ */
  auth.onAuthStateChanged(user => {
    // 1) Sin sesión => volver al login (protege la ruta)
    if (!user) { location.href = "login.html"; return; }

    // 2) Pinta el correo del usuario
    const emailSpan = document.getElementById("userEmail");
    if (emailSpan) emailSpan.textContent = user.email || "";

    // 3) Botón “Salir” (cierra sesión y vuelve a login por el onAuthStateChanged)
    const btnLogout = document.getElementById("logout");
    if (btnLogout) btnLogout.onclick = () => auth.signOut();

    // 4) Muestra u oculta la pestaña de Configuración según rol (ADMIN_UIDS)
    const tabCfg = document.getElementById("tabCfg");
    if (tabCfg) tabCfg.classList.toggle("oculto", !ADMIN_UIDS.includes(user.uid));
  });
}

/* 8) Exponer la función para que el HTML pueda llamarla:
      - En login.html:  authInit({ loginPage: true })
      - En dashboard:   authInit() */
window.authInit = authInit;
