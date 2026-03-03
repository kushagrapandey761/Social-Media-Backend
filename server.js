const express = require("express");
const bcryptjs = require("bcryptjs");
const redisClient = require("./redisClient");
const session = require("express-session");
const { RedisStore } = require("connect-redis");
const authMiddleware = require("./middleware/authMiddleware");
const uploadMedia = require("./middleware/upload.middleware");
const { User, Post } = require("./db");
const cors = require("cors");

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

app.use(
  cors({
    origin: "http://localhost:3000", // frontend URL
    credentials: true, // VERY IMPORTANT for sessions
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
    username: user.username,
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

    res.json({ username: user.username, email: user.email, userAvatar: user.userAvatar });
  } catch (error) {
    res.status(500).json({ error: error.message });
  }
});

app.post("/signup", async (req, res) => {
  const { username, email, password } = req.body;
  const existingUser = await User.findOne({ email });
  if (existingUser) {
    return res.status(400).json({ message: "Email already in use" });
  }
  
  // Hash password before saving
  const hashedPassword = await bcryptjs.hash(password, parseInt(process.env.SALT_ROUNDS));
  
  const user = new User({ username, email, password: hashedPassword, userAvatar: "" });
  await user.save();
  res.json({ message: "User created" });
});

app.get("/posts", authMiddleware, async (req, res) => {
  const userId = req.session.user.id;
   // Only return posts not created by the user
  const posts = await Post.find({ authorId: { $ne: userId } });
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
  const { content, media } = req.body;
  const authorId = req.session.user.id;
  const user = await User.findById(authorId);
  const post = new Post({
    content,
    media,
    authorId,
    userName: user.username,
    userAvatar: user.userAvatar,
    createdAt: new Date(),
  });
  await post.save();
  res.json({ post });
});

app.post("/post/:postid/toggleLike", authMiddleware, async (req, res) => {
  const postId = req.params.postid;
  const userId = req.session.user.id;
  try {
    const post = await Post.findById(postId);
    if (!post) {
      return res.status(404).json({ message: "Post not found" });
    }
      // Check if user already liked the post
    if (post.likedBy.includes(userId)) {
      post.likes -= 1;
      post.likedBy.pull(userId); // Remove user from likedBy
      await post.save();
      return res.json({ message: "Post unliked", likes: post.likes });
    }
    else {
      post.likes += 1; // Increment likes
      post.likedBy.push(userId); // Track who liked the post
      await post.save();
      res.json({ message: "Post liked", likes: post.likes });
    }
  } catch (error) {
    res.status(500).json({ error: error.message });
  }
});

app.post("/post/:postid/comment", authMiddleware, async (req, res) => {
  const postId = req.params.postid;
  const { text } = req.body;
  try {
    const post = await Post.findById(postId);
    if (!post) {
      return res.status(404).json({ message: "Post not found" });
    }
    post.comments.push({ text }); // Add comment
    await post.save();
    res.json({ message: "Comment added", comments: post.comments });
  } catch (error) {
    res.status(500).json({ error: error.message });
  }
});

app.get("/me", authMiddleware, async (req, res) => {
  const userId = req.session.user.id;
  try {
    const user = await User.findById(userId);
    if (!user) {
      return res.status(404).json({ message: "User not found" });
    }
    res.json({ _id: user._id, username: user.username, email: user.email, userAvatar: user.userAvatar, likedPosts: user.likedPosts });
  } catch (error) {
    res.status(500).json({ error: error.message });
  }});

app.listen(3001, () => {
  console.log("Server running on port 3001");
});

// Component	      Role
// Cookie	          Stores session ID
// Redis	          Stores session data
// express-session	Connects cookie ↔ Redis
// Middleware	      Protects routes
// TTL	            Auto logout
