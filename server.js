require("dotenv").config();
const express = require("express");
const redisClient = require("./redisClient");
const session = require("express-session");
const { RedisStore } = require("connect-redis");
const cors = require("cors");
const http = require("http");
const passport = require("./passport");
const { initSocket } = require("./socket");
const authRoutes = require("./routes/auth/authRoutes");
const userRoutes = require("./routes/user/userRoutes");
const postRoutes = require("./routes/post/postRoutes");
const commentRoutes = require("./routes/comment/commentRoutes");
const messageRoutes = require("./routes/message/messageRoutes");

const app = express();
app.set("trust proxy", 1);
const server = http.createServer(app);

initSocket(server);
app.use(express.json({ limit: "10mb" }));

const corsOptions = {
  origin: process.env.FRONTEND_LINK,
  credentials: true,
};

app.use(cors(corsOptions));
app.options(/.*/, cors(corsOptions));

app.locals.redisClient = redisClient;

app.use(
  session({
    store: new RedisStore({ client: redisClient }),
    secret: process.env.SESSION_SECRET,
    resave: false,
    saveUninitialized: false,
    proxy: process.env.NODE_ENV === "production",
    cookie: {
      httpOnly: true,
      secure: process.env.NODE_ENV === "production",
      sameSite: process.env.NODE_ENV === "production" ? "none" : "lax",
      maxAge: 1000 * 60 * 60 * 24,
    },
  }),
);

app.use(passport.initialize());
app.use(passport.session());

app.use("/", authRoutes);
app.use("/", userRoutes);
app.use("/", postRoutes);
app.use("/", commentRoutes);
app.use("/", messageRoutes);

const PORT = process.env.PORT || 3001;

server.listen(PORT, () => {
  console.log(`Server running on port ${PORT}`);
});
