const express = require("express");
const bcryptjs = require("bcryptjs");
const redisClient = require("./redisClient");
const session = require("express-session");
const { RedisStore } = require("connect-redis");
const authMiddleware = require("./middleware/authMiddleware");
const uploadMedia = require("./middleware/upload.middleware");
const { User, Post } = require("./db");

const app = express();

// allow larger JSON payloads (base64 images can be big)
app.use(express.json({ limit: '10mb' }));

app.use(
  session({
    store: new RedisStore({ client: redisClient }),
    secret: "mySecretKey",
    resave: false,
    saveUninitialized: false,
    cookie: { maxAge: 1800000 }, // 30 minute
  }),
);

app.post("/login", async (req, res) => {
  const user = await User.findOne({ email: req.body.email });
  if (!user) return res.status(401).send("Invalid credentials");

  // Compare hashed password
  const isPasswordValid = await bcryptjs.compare(req.body.password, user.password);
  if (!isPasswordValid)
    return res.status(401).send("Invalid credentials");

  req.session.user = {
    id: user._id,
    name: user.name,
  };

  // Save session to Redis so it persists across requests
  req.session.save((err) => {
    if (err) return res.status(500).json({ error: "Failed to save session" });
    res.json({ message: "Logged in" });
  });
});

app.get("/users", authMiddleware, async (req, res) => {
  const user = await User.find();
  res.json(user);
});

app.get("/user/:id", authMiddleware, async (req, res) => {
  const userId = req.params.id;

  try {
    // 1️⃣ Check Redis first
    const cachedUser = await redisClient.get(`user:${userId}`);

    if (cachedUser) {
      console.log("Serving from Redis");
      return res.json(JSON.parse(cachedUser));
    }

    // 2️⃣ If not in Redis → Fetch from MongoDB
    console.log("Fetching from MongoDB");
    const user = await User.findById(userId);

    if (!user) {
      return res.status(404).json({ message: "User not found" });
    }

    // 3️⃣ Store in Redis (Expire in 60 seconds)
    await redisClient.setEx(`user:${userId}`, 60, JSON.stringify(user));

    res.json(user);
  } catch (error) {
    res.status(500).json({ error: error.message });
  }
});

app.post("/signin", async (req, res) => {
  const { name, email, password } = req.body;
  
  // Hash password before saving
  const hashedPassword = await bcryptjs.hash(password, process.env.SALT_ROUNDS);
  
  const user = new User({ name, email, password: hashedPassword });
  await user.save();
  res.json({ message: "User created" });
});

app.get("/posts", authMiddleware, async (req, res) => {
  const posts = await Post.find();
  res.json(posts);
});

app.get("/posts/user/:userid", authMiddleware, async (req, res) => {
  const userId = req.params.userid;
  try {
    const posts = await Post.find({ authorId: userId });
    res.json(posts);
  } catch (error) {
    res.status(500).json({ error: error.message });
  }
});

app.get("/post/:postid", authMiddleware, async (req, res) => {
  const postId = req.params.postid;
  try {
    const post = await Post.findById(postId);
    if (!post) {
      return res.status(404).json({ message: "Post not found" });
    }
    res.json(post);
  } catch (error) {
    res.status(500).json({ error: error.message });
  }
});

app.post("/post", authMiddleware, uploadMedia("files"), async (req, res) => {
  const { title, content, media } = req.body;
  const authorId = req.session.user.id;
  const post = new Post({
    title,
    content,
    media,
    authorId,
    createdAt: new Date(),
  });
  await post.save();
  res.json({ post });
});

app.listen(3000, () => {
  console.log("Server running on port 3000");
});

// Component	      Role
// Cookie	          Stores session ID
// Redis	          Stores session data
// express-session	Connects cookie ↔ Redis
// Middleware	      Protects routes
// TTL	            Auto logout
