const express = require("express");
const cloudinary = require("cloudinary").v2;
const authMiddleware = require("../../middleware/authMiddleware");
const uploadMedia = require("../../middleware/upload.middleware");
const { User, Post, Follow } = require("../../db");
const { getIO, getOnlineUsers } = require("../../socket");

const router = express.Router();

router.get("/posts", authMiddleware, async (req, res) => {
  const userId = req.session.user.id;

  const page = parseInt(req.query.page) || 1;
  const limit = parseInt(req.query.limit) || 10;

  const skip = (page - 1) * limit;

  try {
    const posts = await Post.find({ authorId: { $ne: userId } })
      .sort({ createdAt: -1 })
      .skip(skip)
      .limit(limit);

    const totalPosts = await Post.countDocuments({ authorId: { $ne: userId } });

    res.json({
      posts,
      currentPage: page,
      totalPages: Math.ceil(totalPosts / limit),
      hasMore: skip + posts.length < totalPosts,
    });
  } catch (error) {
    res.status(500).json({ error: error.message });
  }
});

router.post("/userPosts", authMiddleware, async (req, res) => {
  const userId = req.body.userId;
  try {
    const posts = await Post.find({ authorId: userId });
    res.json(posts);
  } catch (error) {
    res.status(500).json({ error: error.message });
  }
});

router.post("/getPost", authMiddleware, async (req, res) => {
  const postId = req.body.postId;
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

router.post("/post", authMiddleware, uploadMedia("files"), async (req, res) => {
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
  // Emit the new post to the users that are following the author of the post
  const followers = await Follow.find({ followingId: authorId }).select("followerId");
  const io = getIO();
  const onlineUsers = getOnlineUsers();

  followers.forEach(({ followerId }) => {
    const followerSocket = onlineUsers.get(followerId.toString());
    if (followerSocket) {
      io.to(followerSocket).emit("newPost", post);
    }
  });

  res.json({ post });
});

router.post("/post/toggleLike", authMiddleware, async (req, res) => {
  const postId = req.body.postId;
  const userId = req.session.user.id;
  try {
    const post = await Post.findById(postId);
    if (!post) {
      return res.status(404).json({ message: "Post not found" });
    }
    if (post.likedBy.includes(userId)) {
      post.likes -= 1;
      post.likedBy.pull(userId);
      await post.save();
      return res.json({ message: "Post unliked", likes: post.likes });
    } else {
      post.likes += 1;
      post.likedBy.push(userId);
      await post.save();
      res.json({ message: "Post liked", likes: post.likes });
    }
  } catch (error) {
    res.status(500).json({ error: error.message });
  }
});

router.post("/post/:postid/comment", authMiddleware, async (req, res) => {
  const postId = req.params.postid;
  const { text } = req.body;
  try {
    const post = await Post.findById(postId);
    if (!post) {
      return res.status(404).json({ message: "Post not found" });
    }
    post.comments.push({ text });
    await post.save();
    res.json({ message: "Comment added", comments: post.comments });
  } catch (error) {
    res.status(500).json({ error: error.message });
  }
});

router.delete("/deletePost", authMiddleware, async (req, res) => {
  const postId = req.body.postId;
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
      cloudinary.api.delete_resources([media.publicId], { resource_type: media.type }, (error) => {
        if (error) console.error("Cloudinary deletion error:", error);
      });
    });
    await Post.findByIdAndDelete(postId);
    res.json({ message: "Post deleted" });
  } catch (error) {
    res.status(500).json({ error: error.message });
  }
});

module.exports = router;
