/*************************************************************
 *  SCRIPT PRINCIPAL DEL DASHBOARD
 *  - Lectura y gráficas en tiempo real desde Firebase RTDB
 *  - Filtros por rango, promedio, máx/mín, comparar días, fuera de rango
 *  - Auto–refresh, manejo de pestañas, selector de dispositivos (boards)
 *  - Exportación a CSV con manejo regional (Excel)
 *  - Gestión de PIN y alta de nuevos boards (vista admin)
 *************************************************************/

/* ==================== CONFIGURACIÓN BASE ==================== */

// URL raíz de la RTDB donde están los datos por dispositivo
const BASE_URL = "https://esp32-sensores-582d2-default-rtdb.firebaseio.com/data/";

// Identificador del dispositivo actual (se elige en la UI)
let BOARD = "";                // ej. "esp32-1"
// Ruta completa al historial del dispositivo actual (se construye al cambiar BOARD)
let firebaseRoot = "";         // ej. BASE_URL + "esp32-1/historial"
// Referencia al objeto `db` (Firebase Database) inyectado por auth.js
let DB = null;                 // se asigna CUANDO window.db exista

// Cantidad de muestras a mostrar en “tiempo real”
const MAX = 25;

// Límites (umbral semáforo) por variable
const limites = {
  temp : { min:18,  med:28,   max:32  },
  hum  : { min:40,  med:60,   max:75  },
  co2  : { min:400, med:1000, max:1500},
  pm25 : { min:0,   med:35,   max:55  },
  pm1  : { min:0,   med:20,   max:35  },
  pm10 : { min:0,   med:50,   max:75  }
};

// Colores tomados del :root (CSS) con fallback por si no existen
const css = getComputedStyle(document.documentElement);
const col = {
  temp : css.getPropertyValue("--rojo")    || "#e74c3c",
  hum  : css.getPropertyValue("--azul")    || "#3498db",
  co2  : css.getPropertyValue("--morado")  || "#8e44ad",
  pm25 : css.getPropertyValue("--verde")   || "#27ae60"
};

// Mapa { variable: instanciaChartJS }
let charts   = {};
// Etiquetas DOM donde se muestra la fecha del gráfico por variable
let fechaLbl = {};

/* ==================== AUTO–ACTUALIZACIÓN ==================== */

// Intervalo del refresco automático (ms)
const AUTO_REFRESH_MS = 60000;
// Handler del setInterval
let autoTimer = null;
// Recuerda si la serie está en “realtime” o en modo “manual” (filtros)
const lastMode = { temp:'realtime', hum:'realtime', co2:'realtime', pm25:'realtime', pm1:'realtime', pm10:'realtime' };

/* ==================== INTEGRACIONES EXTERNAS ==================== */

// Endpoint y credenciales del Apps Script (para enviar PIN)
const GAS_URL = "https://script.google.com/macros/s/AKfycbxl63vZGRgQoRA9eWhSndAmqLPxQ7xemJpQp2M1sfmly6jdNIluRpLdFd5BKTEcH99j-Q/exec";
const GAS_KEY = "2ce5cb8454ff91b06a449a26aec344f5a534bc1d4fbca7fb421bf63e46e24c24";
const ADMIN_EMAIL = "proyectouts22@gmail.com";

/* ==================== HELPERS GENERALES ==================== */

// Convierte fecha+hora en clave ISO similar a la usada en RTDB
const iso = (d,h="00:00") => `${d}T${h}:00`;

// Convierte { clave: { campos } } en array ordenado por tiempo
// Resultado: [{t: timestamp, ...valores}, ...]
const preparar = obj => Object.entries(obj||{})
  .map(([k,v])=>({t:k, ...v}))
  .sort((a,b)=> new Date(a.t) - new Date(b.t));

// Actualiza la etiqueta de fecha asociada a una variable
const setDate  = (v, txt="") => {
  // pm1 y pm10 comparten etiqueta con pm25
  const el = fechaLbl[v] || ((v==="pm1"||v==="pm10") ? fechaLbl.pm25 : null);
  if (el) el.innerText = txt;
};

// Espera a que haya un usuario autenticado (necesario para vista admin)
const waitAuthUser = () => new Promise(resolve=>{
  if (firebase && firebase.auth && firebase.auth().currentUser) return resolve(firebase.auth().currentUser);
  const unsub = firebase.auth().onAuthStateChanged(u => { unsub(); resolve(u); });
});

/* Espera a que window.db (RTDB) esté disponible (lo prepara auth.js) */
async function waitForDB(maxMs = 8000){
  const t0 = Date.now();
  return new Promise(resolve=>{
    const id = setInterval(()=>{
      if (window.db) { clearInterval(id); DB = window.db; resolve(DB); }
      else if (Date.now() - t0 > maxMs) { clearInterval(id); console.error("db no disponible"); resolve(null); }
    }, 60);
  });
}

/* Espera a que firebaseRoot esté definido (evita primer clic “muerto”) */
async function waitRoot(maxMs = 6000){
  if (firebaseRoot) return true;
  const t0 = Date.now();
  return new Promise(res=>{
    const id = setInterval(()=>{
      if (firebaseRoot){ clearInterval(id); res(true); }
      else if (Date.now() - t0 > maxMs){ clearInterval(id); res(false); }
    }, 60);
  });
}

/* ==================== CHARTS (Chart.js) ==================== */

// Crea un gráfico de líneas con configuración base
function newChart(id, label, color){
  const canvas = document.getElementById(id);
  if (!canvas) { console.warn("Canvas no encontrado:", id); return null; }
  // Destruye un gráfico anterior si existe (evita fugas y overlays)
  const prev = Chart.getChart(canvas);
  if (prev) prev.destroy();

  return new Chart(canvas,{
    type:"line",
    data:{ labels:[], datasets:[{
      label, data:[], borderColor:color,
      backgroundColor:color+"33", tension:.25, borderWidth:2, fill:false
    }]},
    options:{
      maintainAspectRatio:false, responsive:true,
      scales:{
        // Eje X con etiquetas de hora giradas (HH:mm)
        x:{ ticks:{ autoSkip:false,maxRotation:90,minRotation:90,align:"end"} },
        // Eje Y con rejilla tenue y origen 0
        y:{ beginAtZero:true, grid:{ color:"#e0e3eb55"} }
      },
      plugins:{ legend:{ labels:{ boxWidth:14 }}}
    }
  });
}

// Sustituye labels y datos en un gráfico y refresca
function update(v,lbl,data){
  if (!charts[v]) return;
  charts[v].data.labels = lbl;
  charts[v].data.datasets[0].data = data;
  charts[v].update();
}

// Restaura el dataset a su estado simple (una sola serie)
function resetDataset(v){
  if (!charts[v]) return;
  const color = col[v] || col.pm25;
  charts[v].data.datasets = [{
    label: v.toUpperCase(),
    data: [],
    borderColor: color,
    backgroundColor: color + "33",
    borderWidth: 2,
    fill: false,
    tension: .2
  }];
}

/* ==================== SEMÁFORO DE ESTADO ==================== */

// Colorea el estado según el último valor y umbrales definidos
function estado(v,valor){
  let el = document.getElementById("estado"+v.toUpperCase());
  // pm1/pm10 reutilizan el estado de PM2.5 en la UI
  if (!el && (v==="pm1" || v==="pm10")) el = document.getElementById("estadoPM25");
  const L = limites[v] || limites.pm25;
  if (!el || !L || typeof valor!=="number") return;

  el.className = "estado";
  if (valor <= L.med){ el.classList.add("ok");   el.textContent = "✓ Dentro de lo normal"; }
  else if (valor <= L.max){ el.classList.add("warn"); el.textContent = "● Valor medio – atención"; }
  else { el.classList.add("bad");  el.textContent = "‼ Valor alto – revisar"; }
}

/* ==================== LECTOR HTTP A RTDB ==================== */

// Wrapper simple de fetch→json con manejo de error
const fb = async url=>{
  const r = await fetch(url);
  return r.ok ? r.json() : (console.error("Firebase:",r.status,url),{});
};

/* ==================== MODOS DE CONSULTA (acciones de UI) ==================== */

// Verifica que ya se seleccionó un dispositivo
function ensureRoot(){ if(!firebaseRoot){ console.warn("Sin board seleccionado aún"); return false; } return true; }

// Modo “Tiempo real”: últimas MAX muestras
async function tiempoReal(v){
  if (!charts[v]) return;
  if (!firebaseRoot) await waitRoot();
  if (!ensureRoot()) { alert("Selecciona un dispositivo primero"); return; }

  resetDataset(v);
  const arr = preparar(await fb(firebaseRoot+".json")).slice(-MAX);
  if(!arr.length) return;
  update(v, arr.map(o=>o.t.slice(11,16)), arr.map(o=>o[v]));
  setDate(v,"");  estado(v, arr[arr.length-1][v]);
}

// Modo “Rango”: día + hora inicio/fin
async function rango(v,d,i,f){
  if (!charts[v]) return;
  if (!firebaseRoot) await waitRoot();
  if (!ensureRoot()) { alert("Selecciona un dispositivo primero"); return; }

  const q = `${firebaseRoot}.json?orderBy="%24key"&startAt="${iso(d,i)}"&endAt="${iso(d,f)}"`;
  const arr = preparar(await fb(q));
  if(!arr.length) return alert("Sin datos");
  update(v, arr.map(o=>o.t.slice(11,16)), arr.map(o=>o[v]));
  setDate(v,d);  estado(v,arr[arr.length-1][v]);
}

// Modo “Promedio” del día
async function promedio(v,d){
  if (!charts[v]) return;
  if (!firebaseRoot) await waitRoot();
  if (!ensureRoot()) { alert("Selecciona un dispositivo primero"); return; }

  const arr = preparar(await fb(firebaseRoot+".json")).filter(o=>o.t.startsWith(d));
  if(!arr.length) return alert("Sin datos");
  const prom = arr.reduce((s,o)=>s+o[v],0)/arr.length;
  update(v,["prom"],[Number(prom.toFixed(2))]);
  setDate(v,d); estado(v,prom);
}

// Modo “Máx/Min” del día
async function maxmin(v,d){
  if (!charts[v]) return;
  if (!firebaseRoot) await waitRoot();
  if (!ensureRoot()) { alert("Selecciona un dispositivo primero"); return; }

  const arr = preparar(await fb(firebaseRoot+".json")).filter(o=>o.t.startsWith(d));
  if(!arr.length) return alert("Sin datos");
  const vals = arr.map(o=>o[v]);
  update(v,["min","max"],[Math.min(...vals),Math.max(...vals)]);
  setDate(v,d); estado(v,Math.max(...vals));
}

// Modo “Máx/Min” en todo el histórico del dispositivo
async function maxminHistorico(v){
  if (!charts[v]) return;
  if (!firebaseRoot) await waitRoot();
  if (!ensureRoot()) { alert("Selecciona un dispositivo primero"); return; }

  const arr = preparar(await fb(firebaseRoot + ".json"));
  if(!arr.length) return alert("Sin datos");
  const vals = arr.map(o => o[v]);
  update(v, ["min","max"], [Math.min(...vals), Math.max(...vals)]);
  setDate(v, "Histórico");
  estado(v, Math.max(...vals));
}

// Modo “Comparar días” (dos series en el mismo gráfico)
async function compararDias(v,d1,d2,i,f){
  if (!charts[v]) return;
  if (!firebaseRoot) await waitRoot();
  if (!ensureRoot()) { alert("Selecciona un dispositivo primero"); return; }

  const q = d=>`${firebaseRoot}.json?orderBy="%24key"&startAt="${iso(d,i)}"&endAt="${iso(d,f)}"`;
  const [arr1,arr2] = await Promise.all([fb(q(d1)), fb(q(d2))]).then(rs=>rs.map(preparar));
  if(!arr1.length||!arr2.length) return alert("Sin datos en alguno de los días");

  charts[v].data.labels = arr1.map(o=>o.t.slice(11,16));
  charts[v].data.datasets = [
    { label:d1, data:arr1.map(o=>o[v]), borderColor:col[v]||col.pm25, backgroundColor:(col[v]||col.pm25)+"22", borderWidth:2, fill:false, tension:.25 },
    { label:d2, data:arr2.map(o=>o[v]), borderColor:"#8e44ad", backgroundColor:"#8e44ad22", borderWidth:2, fill:false, tension:.25 }
  ];
  charts[v].update();
  setDate(v,`${d1} vs ${d2}`); estado(v,arr1[arr1.length-1][v]);
}

// Modo “Fuera de rango” (solo puntos que exceden los umbrales)
async function fueraRango(v){
  if (!charts[v]) return;
  if (!firebaseRoot) await waitRoot();
  if (!ensureRoot()) { alert("Selecciona un dispositivo primero"); return; }

  const L = limites[v] || limites.pm25;
  const arr = preparar(await fb(firebaseRoot+".json"))
              .filter(o=>o[v]>L.max || o[v]<L.min);
  if(!arr.length) return alert("No se detectaron valores fuera de rango.");
  update(v, arr.map(o=>o.t.slice(11,16)), arr.map(o=>o[v]));
  setDate(v,"Fuera de rango"); estado(v,arr[arr.length-1][v]);
}

/* ==================== ENLAZADO DE CONTROLES ==================== */

// Conecta botones y entradas de cada tarjeta de variable
function wiring(){
  document.querySelectorAll(".controles").forEach(ctrl=>{
    const v  = ctrl.dataset.var;                // variable (temp/hum/co2/pm...)
    const d  = ctrl.querySelector(".dia");      // fecha base
    const d2 = ctrl.querySelector(".dia2");     // fecha comparación
    const ini= ctrl.querySelector(".ini");      // hora inicio
    const fin= ctrl.querySelector(".fin");      // hora fin

    // Helper para asignar handlers
    const on = (sel,fn)=>{ const b=ctrl.querySelector(sel); if(b) b.onclick=fn; };

    // Botón: rango horario
    on(".rango",()=> {
      if(d&&ini&&fin&&d.value&&ini.value&&fin.value){
        lastMode[v]='manual'; rango(v,d.value,ini.value,fin.value);
      } else alert("Selecciona fecha y rango");
    });
    // Botón: promedio del día
    on(".prom", ()=> {
      if(d&&d.value){ lastMode[v]='manual'; promedio(v,d.value); }
      else alert("Selecciona fecha");
    });
    // Botón: máx/mín (del día si hay fecha, si no: histórico)
    on(".mm",   ()=> {
      if(d&&d.value){ lastMode[v]='manual'; maxmin(v,d.value); }
      else { lastMode[v]='manual'; maxminHistorico(v); }
    });
    // Botón: comparar días
    on(".cmp",  ()=> {
      if(d&&d2&&ini&&fin&&d.value&&d2.value&&ini.value&&fin.value){
        lastMode[v]='manual'; compararDias(v,d.value,d2.value,ini.value,fin.value);
      } else alert("Selecciona los 2 días y rango");
    });
    // Botón: fuera de rango
    on(".out",  ()=> { lastMode[v]='manual'; fueraRango(v); });

    /* Botón En vivo: limpia filtros y vuelve a tiempo real */
    on(".live", ()=>{
      [d,d2,ini,fin].forEach(el=>{ if(el) el.value=""; });
      lastMode[v] = 'realtime';
      setDate(v,"");
      tiempoReal(v);
      startAutoRefresh();
    });

    // Si el usuario borra todos los filtros, volvemos a tiempo real automáticamente
    const watchers = [d,d2,ini,fin].filter(Boolean);
    const checkEmpty = ()=>{
      const empty = x => !x || !x.value;
      if (empty(d) && empty(d2) && empty(ini) && empty(fin)) {
        lastMode[v] = 'realtime'; tiempoReal(v);
      }
    };
    watchers.forEach(el=>{
      el.addEventListener('input', checkEmpty, {passive:true});
      el.addEventListener('change', checkEmpty);
    });
  });

  /* Guarda la pestaña activa para restaurarla al recargar */
  document.addEventListener('click', (e)=>{
    const btn = e.target.closest('.tablink');
    if (btn && btn.dataset.tab) {
      try { localStorage.setItem('activeTab', btn.dataset.tab); } catch {}
    }
  }, {passive:true});
}

/* ==================== PESTAÑAS (delegación) ==================== */

// Manejo de pestañas sin recargar la página
function tabLogic(){
  const activar = nombre=>{
    // Activa botón
    document.querySelectorAll(".tablink").forEach(b=>b.classList.toggle('active', b.dataset.tab===nombre));
    // Muestra contenido de la pestaña
    document.querySelectorAll(".tabcontent").forEach(v=>v.classList.toggle('active', v.id===nombre));
  };

  // Delegación: un solo listener para todas las pestañas
  document.addEventListener('click', (e)=>{
    const btn = e.target.closest('.tablink');
    if (!btn) return;
    const tab = btn.dataset.tab;
    if (!tab) return;
    activar(tab);
  }, {passive:true});

  // Estado inicial (última pestaña usada o “intro”)
  const saved = localStorage.getItem('activeTab');
  activar(saved || 'intro');
}

/* ==================== SELECTOR DE DISPOSITIVOS ==================== */

// Construye los botones de boards disponibles
function construirSelector(arr){
  const c = document.getElementById("selBoards");
  if (!c) return;
  c.innerHTML = "";
  arr.forEach(id=>{
    const b = document.createElement("button");
    b.type = "button";
    b.textContent = id;
    b.onclick = ()=> cambiarBoard(id);
    c.appendChild(b);
  });
  // Si no hay board seleccionado, toma el primero
  if(arr.length && !BOARD) cambiarBoard(arr[0]);
}

// Cambia el dispositivo activo y refresca todas las variables
function cambiarBoard(id){
  BOARD        = id;
  firebaseRoot = `${BASE_URL}${id}/historial`;
  // Marca visualmente el botón activo
  document.querySelectorAll("#selBoards button")
          .forEach(btn=>btn.classList.toggle("sel", btn.textContent===id));

  // Vuelve todo a “tiempo real” y repinta
  ["temp","hum","co2","pm25","pm1","pm10"].forEach(v=>{
    lastMode[v] = 'realtime';
    if (charts[v]) tiempoReal(v);
  });
  // Actualiza etiqueta en exportación (si existe)
  const expLbl = document.getElementById("expBoardLabel");
  if (expLbl) expLbl.textContent = id;
  startAutoRefresh(true);
}

/* ==================== LISTA DE BOARDS (admin) ==================== */

// Escucha en tiempo real la lista de boards (ruta /boards)
async function escucharBoards(){
  await waitForDB();
  if (DB) {
    DB.ref("boards").on("value", snap=>{
      const val = snap.val();
      if (val) construirSelector(Object.keys(val||{}));
      else fallbackBoards();
    }, err=>{
      console.error("boards listener:", err);
      fallbackBoards();
    });
  } else {
    fallbackBoards();
  }
}

// Fallback: si no hay /boards, trata de listar llaves en /data
function fallbackBoards(){
  fetch(BASE_URL + ".json?shallow=true")
    .then(r => r.ok ? r.json() : {})
    .then(keys => construirSelector(Object.keys(keys || {})))
    .catch(err => console.error("fallback /data:", err));
}

/* === Lista admin de boards (#listaBoards) === */
function renderAdminBoardsList(map){
  const list = document.getElementById("listaBoards");
  if (!list) return;

  list.innerHTML = "";
  const ids = Object.keys(map || {}).sort();

  ids.forEach(id => {
    const row = document.createElement("div");
    row.style.cssText = "display:flex;gap:.5rem;align-items:center;margin:.35rem 0;";
    row.innerHTML = `
      <input type="text" value="${id}" disabled
             style="flex:1;background:rgba(255,255,255,.06);color:inherit;border:1px solid rgba(255,255,255,.15);border-radius:10px;padding:.45rem .6rem;outline:0;">
      <button type="button" data-del="${id}" title="Eliminar"
              style="background:#ff6b6b;border:none;color:#fff;padding:.45rem .7rem;border-radius:8px;cursor:pointer;font-weight:800">✖</button>
    `;
    list.appendChild(row);
  });

  // Delegación para eliminar
  list.addEventListener("click", async (e)=>{
    const btn = e.target.closest("[data-del]");
    if (!btn) return;
    const id = btn.getAttribute("data-del");
    if (!id) return;
    if (confirm(`¿Eliminar el dispositivo “${id}”?`)) {
      try{
        await DB.ref("boards/"+id).remove();
      }catch(err){
        console.error("No se pudo eliminar el board:", err);
        alert("Error eliminando el dispositivo");
      }
    }
  }, { once:true }); // nos suscribimos una vez por render
}

/* === Escuchar boards: selector + lista admin === */
async function escucharBoards(){
  await waitForDB();
  if (DB) {
    DB.ref("boards").on("value", snap=>{
      const val = snap.val();
      if (val) {
        construirSelector(Object.keys(val || {})); // botones de selector arriba
        renderAdminBoardsList(val);                 // lista en configuración
      } else {
        // si no hay boards, limpia ambas vistas
        construirSelector([]);
        renderAdminBoardsList({});
        fallbackBoards();
      }
    }, err=>{
      console.error("boards listener:", err);
      fallbackBoards();
    });
  } else {
    fallbackBoards();
  }
}


/* ==================== PIN POR CORREO (admin) ==================== */

// Genera PIN y lo envía al correo del admin (vía Apps Script)
async function solicitarPin(){
  const msg = document.getElementById("msgCfg");
  const pinInfo = document.getElementById("pinInfo");
  msg.textContent = "";
  try{
    await waitForDB();
    const user = await waitAuthUser();
    if(!user){ msg.textContent="No autenticado"; return; }

    // 6 dígitos, vigencia 5 min
    const code = String(Math.floor(100000 + Math.random()*900000));
    const expiresAt = Date.now() + 5*60*1000;
    await DB.ref(`activePins/${user.uid}/addBoard`).set({ code, expiresAt, used:false, createdAt: Date.now() });

    // POST (no-cors) y GET-beacon de respaldo
    const body = new URLSearchParams({ apiKey: GAS_KEY, to: ADMIN_EMAIL, code });
    try{ fetch(GAS_URL, { method:"POST", mode:"no-cors", headers:{ "Content-Type":"application/x-www-form-urlencoded;charset=UTF-8" }, body }); }catch(_){}
    try{
      const url = `${GAS_URL}?apiKey=${encodeURIComponent(GAS_KEY)}&to=${encodeURIComponent(ADMIN_EMAIL)}&code=${encodeURIComponent(code)}&cb=${Date.now()}`;
      (new Image()).src = url;
    }catch(_){}

    msg.textContent = "PIN enviado (vigencia 5 min).";
    if (pinInfo) pinInfo.textContent = `Se envió a ${ADMIN_EMAIL}.`;
  }catch(e){
    console.error("solicitarPin() error:", e);
    msg.textContent = e?.message || "Error al solicitar PIN";
  }
}

/* Alta de un board nuevo validando PIN */
async function agregarBoard(){
  const msg = document.getElementById("msgCfg");
  const pinInput = document.getElementById("pinCode");
  const id = (document.getElementById("nuevoId")||{}).value?.trim();

  // Validaciones de ID y PIN
  if(!id){ msg.textContent="Ingresa un ID"; return; }
  if(!/^[\w-]+$/.test(id)){ msg.textContent="ID inválido"; return; }
  if(!pinInput || !/^\d{6}$/.test(pinInput.value)){ msg.textContent="PIN inválido"; return; }

  try{
    await waitForDB();
    const user = await waitAuthUser();
    if(!user){ msg.textContent="No autenticado"; return; }

    // Lee el PIN almacenado
    const snap = await DB.ref(`activePins/${user.uid}/addBoard`).get();
    if(!snap.exists()){ msg.textContent="Solicita el PIN primero"; return; }
    const { code, expiresAt, used } = snap.val() || {};
    const now = Date.now();

    // Reglas de uso/tiempo
    if(used){ msg.textContent = "PIN ya utilizado"; return; }
    if(!code || !expiresAt){ msg.textContent = "PIN no disponible"; return; }
    if(now > Number(expiresAt)){ msg.textContent = "PIN vencido"; return; }
    if(pinInput.value !== String(code)){ msg.textContent = "PIN incorrecto"; return; }

    // Crea el board y marca el PIN como usado
    await DB.ref("boards/"+id).set(true);
    msg.textContent = "Agregado";
    (document.getElementById("nuevoId")||{}).value = "";
    pinInput.value = "";
    await DB.ref(`activePins/${user.uid}/addBoard`).update({ used:true, usedAt: now });
    cambiarBoard(id);
  }catch(e){
    console.error(e);
    msg.textContent = "Error";
  }
}

/* ==================== AUTO REFRESH ==================== */

// Detiene el timer de auto actualización
function stopAutoRefresh(){
  if (autoTimer) { clearInterval(autoTimer); autoTimer = null; }
}

// Arranca/refresca el auto update (todas las variables en realtime)
function startAutoRefresh(forceRestart=false){
  if (autoTimer && !forceRestart) return;
  stopAutoRefresh();
  const tick = async ()=>{
    if (document.hidden) return;          // no actualiza en background
    if (!firebaseRoot) await waitRoot();  // asegura board listo
    if (!ensureRoot()) return;

    // Lee todo el historial y se queda con las últimas MAX muestras
    const arr = preparar(await fb(firebaseRoot + ".json"));
    if (!arr.length) return;
    const slice = arr.slice(-MAX);
    const labels = slice.map(o=>o.t.slice(11,16));
    const last   = slice[slice.length-1];
    ["temp","hum","co2","pm25","pm1","pm10"].forEach(v=>{
      // Solo actualiza si esa variable está en modo realtime
      if (!charts[v] || lastMode[v] !== 'realtime') return;
      resetDataset(v);
      update(v, labels, slice.map(o=>o[v]));
      setDate(v,"");
      estado(v, last[v]);
    });
  };
  autoTimer = setInterval(tick, AUTO_REFRESH_MS);
  tick(); // refresco inmediato al iniciar
}

/* ==================== INICIALIZACIÓN ==================== */

window.addEventListener("DOMContentLoaded", async ()=>{
  // Crea los gráficos
  charts.temp = newChart("graficoTemp","Temperatura (°C)",col.temp);
  charts.hum  = newChart("graficoHum","Humedad (%)",     col.hum);
  charts.co2  = newChart("graficoCO2","CO\u2082 (ppm)",  col.co2);
  charts.pm25 = newChart("graficoPM25","PM2.5 (µg/m³)",  col.pm25);
  charts.pm1  = newChart("graficoPM1",  "PM1.0 (µg/m³)", col.pm25);
  charts.pm10 = newChart("graficoPM10", "PM10 (µg/m³)",  col.pm25);

  // Enlaces a etiquetas de fecha bajo cada gráfico
  fechaLbl.temp = document.getElementById("fechaTemp");
  fechaLbl.hum  = document.getElementById("fechaHum");
  fechaLbl.co2  = document.getElementById("fechaCO2");
  fechaLbl.pm25 = document.getElementById("fechaPM25");
  fechaLbl.pm1  = fechaLbl.pm25;
  fechaLbl.pm10 = fechaLbl.pm25;

  // Rellena tablas de rangos (normal/medio/alto) en cada tarjeta
  const setTxt = (id, v)=>{ const el=document.getElementById(id); if(el) el.textContent=v; };
  const fill = (v, cap)=>{
    const L = limites[v]; if(!L) return;
    setTxt(`rN${cap}`, `≤ ${L.med}`);
    setTxt(`rM${cap}`, `${L.med+1} – ${L.max}`);
    setTxt(`rA${cap}`, `> ${L.max}`);
  };
  fill("temp","Temp"); fill("hum","Hum"); fill("co2","Co2"); fill("pm25","Pm25"); fill("pm1","Pm1"); fill("pm10","Pm10");

  // Enlaza controles, pestañas y boards
  wiring(); 
  tabLogic();
  escucharBoards();

  // Pausa/retoma auto-refresh al cambiar visibilidad
  document.addEventListener('visibilitychange', ()=>{ if (document.hidden) stopAutoRefresh(); else startAutoRefresh(true); });

  // Botones de admin
  const btnAdd = document.getElementById("btnAddBoard"); if (btnAdd) btnAdd.onclick = agregarBoard;
  const btnPin = document.getElementById("btnSendPin");  if (btnPin) btnPin.onclick = solicitarPin;

  // Botón de exportación (si existe)
  const btnExport = document.getElementById("btnExport");
  if (btnExport) btnExport.onclick = exportarDatos;
});

/* ==================== EXPORTAR DATOS (CSV) ==================== */

// Serializa registros a CSV usando ';' como separador (mejor para Excel ES)
function toCSV(rows, sep = ";"){
  // Escapa valores: comillas dobles, saltos y separadores; añade comillas si es necesario
  const esc = (val)=>{
    if (val === null || val === undefined) return "";
    const s = String(val);
    const needQuote = s.includes(sep) || s.includes("\n") || s.includes("\r") || s.includes('"') || s.includes(";");
    const ss = s.replace(/"/g,'""');
    return needQuote ? `"${ss}"` : ss;
  };
  // Encabezados
  const header = ["timestamp","temp","hum","co2","pm1","pm25","pm10"].join(sep);
  // Filas
  const lines = rows.map(r => [
    esc(r.timestamp),
    esc(r.temp),
    esc(r.hum),
    esc(r.co2),
    esc(r.pm1),
    esc(r.pm25),
    esc(r.pm10)
  ].join(sep));
  // BOM UTF-8 para que Excel detecte bien acentos y separador regional
  return "\uFEFF" + [header, ...lines].join("\r\n");
}

// Descarga CSV del rango seleccionado
async function exportarDatos(){
  if (!firebaseRoot) await waitRoot();
  if (!ensureRoot()) { alert("Selecciona un dispositivo primero"); return; }

  // Rango de fechas (YYYY-MM-DD)
  const from = document.getElementById("expFrom")?.value;
  const to   = document.getElementById("expTo")?.value;
  const msg  = document.getElementById("expMsg");
  if (!from || !to){ alert("Selecciona rango de fechas"); return; }

  // Consulta por clave (timestamp ISO) entre 00:00 y 23:59
  const q = `${firebaseRoot}.json?orderBy="%24key"&startAt="${from}T00:00:00"&endAt="${to}T23:59:59"`;
  const arr = preparar(await fb(q));
  if (!arr.length){ alert("Sin datos en el rango"); return; }

  // Normaliza a columnas
  const rows = arr.map(o=>({
    timestamp: o.t,
    temp:o.temp, hum:o.hum, co2:o.co2, pm1:o.pm1, pm25:o.pm25, pm10:o.pm10
  }));

  // Genera CSV y dispara descarga
  const csv = toCSV(rows, ";");
  const fname = `datos_${BOARD || "board"}_${from}_a_${to}.csv`;
  const blob = new Blob([csv], {type:"text/csv;charset=utf-8"});

  // Usa FileSaver si existe; si no, crea <a download> con objectURL
  if (typeof saveAs === "function"){
    saveAs(blob, fname);
  } else {
    const url = URL.createObjectURL(blob);
    const a = document.createElement("a");
    a.href = url; a.download = fname;
    document.body.appendChild(a);
    a.click();
    setTimeout(()=>{ URL.revokeObjectURL(url); a.remove(); }, 500);
  }

  if (msg) msg.textContent = "CSV generado.";
}
