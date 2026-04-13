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
const crypto = require("crypto");
const nodemailer = require("nodemailer");

const app = express();
const server = http.createServer(app);


initSocket(server);

// allow larger JSON payloads (base64 images can be big)
app.use(express.json({ limit: '10mb' }));

app.set("trust proxy", 1); // VERY IMPORTANT for Render (HTTPS proxy)

app.use(
  session({
    store: new RedisStore({ client: redisClient }),
    secret: process.env.SESSION_SECRET,
    resave: false,
    saveUninitialized: false,
    cookie: {
      httpOnly: true,
      secure: process.env.NODE_ENV === "production", // required for HTTPS (Render) (true for production, false for local)
      sameSite: process.env.NODE_ENV === "production" ? "none" : "lax", // required for cross-origin (lax for local, none for production)
      maxAge: 1000 * 60 * 60 * 24, // 1 day
    },
  }),
);
app.use(
  cors({
    origin: process.env.FRONTEND_LINK, // frontend URL
    credentials: true, // VERY IMPORTANT for sessions
  }),
);

const transporter = nodemailer.createTransport({
  service: "gmail",
  auth: {
    user: `${process.env.SENDER_EMAIL}`,
    pass: `${process.env.SENDER_PASSWORD}`,
  },
});

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

app.get("/chatUsers", authMiddleware, async (req, res) => {
  const currentUserId = new mongoose.Types.ObjectId(req.session.user.id);

  try {
    const chatUsers = await Message.aggregate([
      {
        $match: {
          $or: [{ senderId: currentUserId }, { receiverId: currentUserId }],
        },
      },
      { $sort: { createdAt: -1 } },
      {
        $addFields: {
          otherUserId: {
            $cond: [
              { $eq: ["$senderId", currentUserId] },
              "$receiverId",
              "$senderId",
            ],
          },
        },
      },
      {
        $group: {
          _id: "$otherUserId",
          lastMessage: { $first: "$$ROOT" },
        },
      },
      {
        $lookup: {
          from: "users",
          localField: "_id",
          foreignField: "_id",
          as: "user",
        },
      },
      { $unwind: "$user" },
      {
        $project: {
          _id: 0,
          user: {
            _id: "$user._id",
            username: "$user.username",
            userAvatar: "$user.userAvatar",
          },
          lastMessage: {
            _id: "$lastMessage._id",
            senderId: "$lastMessage.senderId",
            receiverId: "$lastMessage.receiverId",
            text: "$lastMessage.text",
            postId: "$lastMessage.postId",
            type: "$lastMessage.type",
            seen: "$lastMessage.seen",
            createdAt: "$lastMessage.createdAt",
          },
        },
      },
      { $sort: { "lastMessage.createdAt": -1 } },
    ]);

    res.json(chatUsers);
  } catch (error) {
    res.status(500).json({ error: error.message });
  }
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
    const user = await User.findById(userId).select("-password -email"); // Exclude password

    if (!user) {
      return res.status(404).json({ message: "User not found" });
    }

    const followersCount = await Follow.countDocuments({
      followingId: userId,
    });

    const followingCount = await Follow.countDocuments({
      followerId: userId,
    });

    // 3️⃣ Store in Redis (Expire in 60 seconds)
    const userData = { _id: user._id, username: user.username, userAvatar: user.userAvatar, followersCount, followingCount, bio: user.bio, createdAt: user.createdAt };
    await redisClient.setEx(`user:${userId}`, 60, JSON.stringify(userData));

    res.json(userData);
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
  const { receiverId, text, postId, type, currentMediaIndex } = req.body;
  const senderId = req.session.user.id;

  if ((!text && !postId) || (text && postId)) {
    return res.status(400).json({
      message: "Send either text or post, not both",
    });
  }

  const message = await Message.create({
    senderId,
    receiverId,
    text: text || "",
    postId: postId || null,
    type,
    currentMediaIndex: currentMediaIndex !== undefined ? currentMediaIndex : null,
    seen: false,
  });

  const populatedMessage = await Message.findById(message._id).populate({
    path: "postId",
    select: "content media userName userAvatar",
  });
  const onlineUsers = getOnlineUsers();
  const receiverSocket = onlineUsers.get(receiverId);

  if (receiverSocket) {
    const io = getIO();
    io.to(receiverSocket).emit("receiveMessage", populatedMessage);
  }

  res.json(populatedMessage);
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
    }).sort({ createdAt: 1 }).populate({path: "postId", select: "content media userName userAvatar"});
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

app.post("/forgot-password", async (req, res) => {
  const { email } = req.body;

  const user = await User.findOne({ email });

  // Don't reveal if user exists (security)
  if (!user) {
    return res.json({ message: "If email exists, reset link sent" });
  }

  // Generate token
  const token = crypto.randomBytes(32).toString("hex");

  user.resetPasswordToken = token;
  user.resetPasswordExpires = Date.now() + 1000 * 60 * 15; // 15 mins

  await user.save();

  const resetLink = `${process.env.FRONTEND_LINK}/reset-password/${token}`;

  await transporter.sendMail({
    to: user.email,
    subject: "Reset Password",
    html: `<a href="${resetLink}">Reset Password</a>`,
  });

  res.json({ message: "Reset link sent" });
});

app.post("/reset-password/:token", async (req, res) => {
  const { token } = req.params;
  const { password } = req.body;

  const user = await User.findOne({
    resetPasswordToken: token,
    resetPasswordExpires: { $gt: Date.now() },
  });

  if (!user) {
    return res.status(400).json({ message: "Invalid or expired token" });
  }

  const hashedPassword = await bcryptjs.hash(
    password,
    parseInt(process.env.SALT_ROUNDS),
  );

  user.password = hashedPassword;

  // Clear token
  user.resetPasswordToken = undefined;
  user.resetPasswordExpires = undefined;

  await user.save();

  res.json({ message: "Password reset successful" });
});



// Logout route to destroy session
app.post("/logout", authMiddleware, (req, res) => {
  req.session.destroy((err) => {
    if (err) return res.status(500).json({ error: "Failed to logout" });
    res.clearCookie("connect.sid");
    res.json({ message: "Logged out" });
  });
});

const PORT = process.env.PORT || 3001;

server.listen(PORT, () => {
  console.log(`Server running on port ${PORT}`);
});

// Component	      Role
// Cookie	          Stores session ID
// Redis	          Stores session data
// express-session	Connects cookie ↔ Redis
// Middleware	      Protects routes
// TTL	            Auto logout
