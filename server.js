const express = require("express");
const bcryptjs = require("bcryptjs");
const redisClient = require("./redisClient");
const session = require("express-session");
const { RedisStore } = require("connect-redis");
const authMiddleware = require("./middleware/authMiddleware");
const uploadMedia = require("./middleware/upload.middleware");
const { uploadProfileMedia } = require("./middleware/upload.middleware");
const { User, Post, Follow, Comment, Message } = require("./db");
const cors = require("cors");
const cloudinary = require("cloudinary").v2;
const { getIO, initSocket, getOnlineUsers } = require("./socket");
const http = require("http");
const mongoose = require("mongoose")

const app = express();
const server = http.createServer(app);


initSocket(server);

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
  const currentUserId = req.session.user.id;
  const users = await User.find({ _id: { $ne: currentUserId } });

  const following = await Follow.find({
    followerId: currentUserId,
  }).select("followingId");

  const followingIds = following.map((f) => f.followingId.toString());

  const result = users.map((user) => ({
    ...user.toObject(),
    isFollowing: followingIds.includes(user._id.toString()),
  }));

  res.json(result);
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
  const { name, username, email, password } = req.body;
  let existingUser = await User.findOne({ email, username });
  if (existingUser) {
    return res.status(400).json({ message: "Email already in use" });
  }
  existingUser = await User.findOne({ username });
  if (existingUser) {
    return res.status(400).json({ message: "Username already in use" });
  }
  
  // Hash password before saving
  const hashedPassword = await bcryptjs.hash(password, parseInt(process.env.SALT_ROUNDS));
  
  const user = new User({ name, username, email, password: hashedPassword, userAvatar: "", bio: "" });
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
    const followersCount = await Follow.countDocuments({
      followingId: userId,
    });

  const followingCount = await Follow.countDocuments({
    followerId: userId,
  });
    if (!user) {
      return res.status(404).json({ message: "User not found" });
    }
    res.json({ _id: user._id, name: user.name, username: user.username, email: user.email, userAvatar: user.userAvatar, followersCount, followingCount, bio: user.bio, coverImage: user.coverImage, createdAt: user.createdAt });
  } catch (error) {
    res.status(500).json({ error: error.message });
  }});

app.patch("/me", authMiddleware, uploadProfileMedia(), async (req, res) => {
  const allowedFields = ["name", "bio", "username"];
  const userId = req.session.user.id;

  const updates = {};
  for (let key of allowedFields) {
    if (req.body[key] !== undefined) {
      updates[key] = req.body[key];
    }
  }

  // Handle uploaded media
  if (req.body.uploadedMedia) {
    if (req.body.uploadedMedia.userAvatar) {
      updates.userAvatar = req.body.uploadedMedia.userAvatar.url;
    }
    if (req.body.uploadedMedia.coverImage) {
      updates.coverImage = req.body.uploadedMedia.coverImage.url;
    }
  }

  if(updates.username) {
    const existingUser = await User.findOne({ username: updates.username });
    if (existingUser && existingUser._id.toString() !== userId) {
      return res.status(400).json({ message: "Username already in use" });
    }
    const posts = await Post.find({ authorId: userId });
    for (let post of posts) {
      post.userName = updates.username;
      await post.save();
    }
  }
  
  if(updates.userAvatar) {
    const user = await User.findById(userId);
    let publicId = null;
    if (user.userAvatar) {
      publicId = user.userAvatar.split("/").slice(-1)[0].split(".")[0];
      publicId = "userAvatar/" + publicId; // Assuming your folder in Cloudinary is named "userAvatar"
    }
    cloudinary.api.delete_resources(
      [publicId],
      { resource_type: "image" },
      (error, result) => {
        if (error) console.error("Cloudinary deletion error:", error);
      },
    );
    const posts = await Post.find({ authorId: userId });
    for (let post of posts) {
      post.userAvatar = updates.userAvatar;
      await post.save();
    }
  }

  if(updates.coverImage) {
    const user = await User.findById(userId);
    let publicId = null;
    if (user.coverImage) {
      publicId = user.coverImage.split("/").slice(-1)[0].split(".")[0];
      publicId = "coverImage/" + publicId; // Assuming your folder in Cloudinary is named "coverImage"
    }
    cloudinary.api.delete_resources(
      [publicId],
      { resource_type: "image" },
      (error, result) => {
        if (error) console.error("Cloudinary deletion error:", error);
      }
    );
  }
  const user = await User.findByIdAndUpdate(
    userId,
    { $set: updates },
    { new: true },
  ).select("-password");

  res.json(user);
});

app.delete("/post/:postid", authMiddleware, async (req, res) => {
  const postId = req.params.postid;
  const userId = req.session.user.id;
  try {
    const post = await Post.findById(postId);
    if (!post) {
      return res.status(404).json({ message: "Post not found" });
    }
    if (post.authorId.toString() !== userId) {
      return res.status(403).json({ message: "Unauthorized" });
    }
    post.media.forEach((media) => {
      cloudinary.api.delete_resources(
        [media.publicId],
        { resource_type: media.type },
        (error, result) => {
          if (error) console.error("Cloudinary deletion error:", error);
        },
      );
    });
    await Post.findByIdAndDelete(postId);
    res.json({ message: "Post deleted" });
  } catch (error) {
    res.status(500).json({ error: error.message });
  }});

  app.post("/toggleFollow/:userid", authMiddleware, async (req, res) => {
  const targetUserId = req.params.userid;
  const currentUserId = req.session.user.id;
  if (targetUserId === currentUserId) {
    return res.status(400).json({ message: "Cannot follow yourself" });
  }
  try {
    const existingFollow = await Follow.findOne({
      followerId: currentUserId,
      followingId: targetUserId,
    });
    if (existingFollow) {
      await Follow.findByIdAndDelete(existingFollow._id);
      return res.json({ message: "Unfollowed" });
    }
    const follow = new Follow({
      followerId: currentUserId,
      followingId: targetUserId,
    });
    await follow.save();
    res.json({ message: "Followed" });
  } catch (error) {
    res.status(500).json({ error: error.message });
  }
});

app.get("/comments/:postid", authMiddleware, async (req, res) => {
  const postId = req.params.postid;
  try {
    const comments = await Comment.find({ postId, parentCommentId: null })
      .sort({ createdAt: -1 })
      .populate("authorId", "username userAvatar");

    res.json(comments);
  } catch (error) {
    res.status(500).json({ error: error.message });
  }
});

app.post("/comment/:postId", authMiddleware, async (req, res) => {
  const { postId } = req.params;
  const { text } = req.body;
  const authorId = req.session.user.id;

  try {
    const post = await Post.findById(postId);

    if (!post) {
      return res.status(404).json({ message: "Post not found" });
    }

    const comment = await Comment.create({
      postId,
      authorId,
      text,
      parentCommentId: null,
    });
    const populatedComment = await Comment.findById(comment._id).populate(
      "authorId",
      "username userAvatar",
    );
    await Post.findByIdAndUpdate(postId, {
      $inc: { commentsCount: 1 },
    });

    res.status(201).json({
      message: "Comment added",
      comment: populatedComment,
    });
  } catch (error) {
    res.status(500).json({ error: error.message });
  }
});

app.post("/reply/:commentid", authMiddleware, async (req, res) => {
  const commentId = req.params.commentid;
  const { text } = req.body;
  const authorId = req.session.user.id;

  try {
    const parentComment = await Comment.findById(commentId);

    if (!parentComment) {
      return res.status(404).json({ message: "Parent comment not found" });
    }

    const reply = await Comment.create({
      postId: parentComment.postId,
      authorId,
      text,
      parentCommentId: commentId,
    });
    parentComment.replyCount += 1;
    await parentComment.save();
    const populatedReply = await Comment.findById(reply._id).populate("authorId", "username userAvatar");
    res.json({ message: "Reply added", reply: populatedReply });
  } catch (error) {
    res.status(500).json({ error: error.message });
  }
});

app.get("/replies/:commentid", authMiddleware, async (req, res) => {
  const commentId = req.params.commentid;
  try {
    const replies = await Comment.find({ parentCommentId: commentId })
      .populate("authorId", "username userAvatar");
    res.json(replies);
  } catch (error) {
    res.status(500).json({ error: error.message });
  }
});

app.post("/sendMessage", authMiddleware, async (req, res) => {
  const { receiverId, text } = req.body;
  const senderId = req.session.user.id;

  const message = await Message.create({
    senderId,
    receiverId,
    text,
    seen: false,
  });

  const onlineUsers = getOnlineUsers();
  const receiverSocket = onlineUsers.get(receiverId);

  if (receiverSocket) {
    const io = getIO();
    io.to(receiverSocket).emit("receiveMessage", message);
  }

  res.json(message);
});

app.get("/messages/lastMessages", async (req, res) => {
  const currentUserId = req.session.user.id;
  const userId = new mongoose.Types.ObjectId(currentUserId);
  try {
    const conversations = await Message.aggregate([
      {
        $match: {
          $or: [{ senderId: userId }, { receiverId: userId }],
        },
      },
      {
        $sort: { createdAt: -1 },
      },
      {
        $group: {
          _id: {
            $cond: [
              { $eq: ["$senderId", userId] },
              "$receiverId",
              "$senderId",
            ],
          },
          lastMessage: { $first: "$$ROOT" },
        },
      },
    ]);
    res.json({ conversations });
  } catch (error) {
    res.status(500).json({ error: error.message });
  }
});

app.get("/messages/:userId", authMiddleware, async (req, res) => {
  const currentUserId = req.session.user.id;
  const otherUserId = req.params.userId;
  try {
    const messages = await Message.find({
      $or: [
        { senderId: currentUserId, receiverId: otherUserId },
        { senderId: otherUserId, receiverId: currentUserId },
      ],
    }).sort({ createdAt: 1 });
    res.json(messages);
  } catch (error) {
    res.status(500).json({ error: error.message });
  }
});

app.get("/messages/unseen/count", authMiddleware, async (req, res) => {
  const currentUserId = req.session.user.id;
  try {
    const count = await Message.countDocuments({
      receiverId: currentUserId,
      seen: false,
    });

    res.json({ count });
  } catch (error) {
    res.status(500).json({ error: error.message });
  }
});

app.get("/messages/unseen/users",authMiddleware,async (req,res)=>{
  const currentUserId = req.session.user.id;
  try{
    const senderIds = await Message.find({
      receiverId: currentUserId,
      seen: false,
    }).select("senderId");
    res.json({ senderIds });
  }catch(error){
    res.status(500).json({ error: error.message });
  }
})



// Logout route to destroy session
app.post("/logout", authMiddleware, (req, res) => {
  req.session.destroy((err) => {
    if (err) return res.status(500).json({ error: "Failed to logout" });
    res.clearCookie("connect.sid");
    res.json({ message: "Logged out" });
  });
});

server.listen(3001, () => {
  console.log("Server running on port 3001");
});

// Component	      Role
// Cookie	          Stores session ID
// Redis	          Stores session data
// express-session	Connects cookie ↔ Redis
// Middleware	      Protects routes
// TTL	            Auto logout
