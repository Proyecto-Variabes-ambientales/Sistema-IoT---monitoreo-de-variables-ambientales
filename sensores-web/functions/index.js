const functions = require("firebase-functions");
const admin = require("firebase-admin");
const nodemailer = require("nodemailer");

admin.initializeApp();

// SMTP desde variables de entorno: functions.config().smtp.*
const smtpCfg = functions.config().smtp || {};
const transporter = nodemailer.createTransport({
  host: smtpCfg.host,
  port: Number(smtpCfg.port || 465),
  secure: String(smtpCfg.secure || "true") === "true",
  auth: smtpCfg.user && smtpCfg.pass ? { user: smtpCfg.user, pass: smtpCfg.pass } : undefined
});

exports.handlePinRequest = functions.database
  .ref("/pinRequests/{requestId}")
  .onCreate(async (snap) => {
    const data = snap.val() || {};
    const { uid, email, purpose } = data;
    if (!uid || !email || purpose !== "addBoard") {
      await snap.ref.remove();
      return null;
    }

    const code = String(Math.floor(100000 + Math.random() * 900000));
    const expiresAt = Date.now() + 5 * 60 * 1000; // 5 min

    await admin.database().ref(`/activePins/${uid}/addBoard`).set({
      code, expiresAt,
      used: false,
      createdAt: admin.database.ServerValue.TIMESTAMP
    });

    const from = smtpCfg.from || smtpCfg.user || "no-reply@example.com";
    const html = `
      <div style="font-family:Arial,sans-serif">
        <p>Tu PIN para agregar una tarjeta es:</p>
        <p style="font-size:22px;font-weight:bold;letter-spacing:3px">${code}</p>
        <p>Vigente por 5 minutos.</p>
        <p>Si no solicitaste este PIN, ignora este correo.</p>
      </div>`;
    const text = `Tu PIN es: ${code}\nVigente por 5 minutos.\n`;

    if (smtpCfg.host && smtpCfg.user && smtpCfg.pass) {
      await transporter.sendMail({ from, to: email, subject: "PIN de verificación (5 min)", text, html });
    } else {
      console.warn("SMTP no configurado: se omitió el envío de correo.");
    }

    await snap.ref.remove();
    return null;
  });
