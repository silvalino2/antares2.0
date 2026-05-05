require("dotenv").config();
const express    = require("express");
const http       = require("http");
const { Server } = require("socket.io");
const session    = require("express-session");
const cors       = require("cors");
const bodyParser = require("body-parser");
const path       = require("path");
const { connect } = require("./services/db");

const app        = express();
const httpServer = http.createServer(app);
const io         = new Server(httpServer, { cors: { origin: "*" } });

app.set("io", io);
app.use(cors());
app.use(bodyParser.urlencoded({ extended: false }));
app.use(bodyParser.json());
app.use(express.static(path.join(__dirname, "public")));
app.use(session({
  secret: process.env.SESSION_SECRET || "antares_v5",
  resave: false,
  saveUninitialized: false,
  cookie: { secure: false, maxAge: 86400000 },
}));

// Routes
app.use("/twilio",     require("./routes/twilio"));
app.use("/at",         require("./routes/voice"));
app.use("/api/admin",  require("./routes/admin"));
app.use("/api/client", require("./routes/client"));

// Pages
app.get("/",          (req, res) => res.sendFile(path.join(__dirname, "public", "index.html")));
app.get("/admin",     (req, res) => res.sendFile(path.join(__dirname, "public", "admin.html")));
app.get("/dashboard", (req, res) => res.sendFile(path.join(__dirname, "public", "dashboard.html")));
app.get("/health",    (req, res) => res.json({ status: "live", platform: "Antares v5", db: "MongoDB Atlas", time: new Date() }));

// Socket.io
io.on("connection", socket => {
  socket.on("join", id => socket.join(id));
});

const PORT = process.env.PORT || 3000;

// ── Connect to MongoDB first, then start HTTP server ──────
connect()
  .then(() => {
    httpServer.listen(PORT, () => {
      console.log(`\n✦  ANTARES Platform v5`);
      console.log(`   Port  : ${PORT}`);
      console.log(`   DB    : MongoDB Atlas`);
      console.log(`   Voice : Africa's Talking`);
      console.log(`   WA/SMS: Twilio`);
      console.log(`   Admin : http://localhost:${PORT}/admin\n`);
    });
  })
  .catch(err => {
    console.error("✘  MongoDB connection failed:", err.message);
    process.exit(1);
  });
