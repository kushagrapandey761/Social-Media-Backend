const express = require("express");
const mongoose = require("mongoose");
const cloudinary = require("cloudinary").v2;
const authMiddleware = require("../../middleware/authMiddleware");
const { uploadProfileMedia } = require("../../middleware/upload.middleware");
const { User, Follow, Message, Post } = require("../../db");

const router = express.Router();

router.get("/users", authMiddleware, async (req, res) => {
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

router.get("/chatUsers", authMiddleware, async (req, res) => {
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

router.get("/user/:id", authMiddleware, async (req, res) => {
  const userId = req.params.id;

  try {
    const cachedUser = await req.app.locals.redisClient.get(`user:${userId}`);

    if (cachedUser) {
      console.log("Serving from Redis");
      return res.json(JSON.parse(cachedUser));
    }

    console.log("Fetching from MongoDB");
    const user = await User.findById(userId).select("-password -email");

    if (!user) {
      return res.status(404).json({ message: "User not found" });
    }

    const followersCount = await Follow.countDocuments({ followingId: userId });
    const followingCount = await Follow.countDocuments({ followerId: userId });

    const userData = {
      _id: user._id,
      username: user.username,
      userAvatar: user.userAvatar,
      followersCount,
      followingCount,
      bio: user.bio,
      createdAt: user.createdAt,
    };
    await req.app.locals.redisClient.setEx(`user:${userId}`, 60, JSON.stringify(userData));

    res.json(userData);
  } catch (error) {
    res.status(500).json({ error: error.message });
  }
});

router.get("/me", authMiddleware, async (req, res) => {
  const userId = req.session.user.id;
  try {
    const user = await User.findById(userId);
    const followersCount = await Follow.countDocuments({ followingId: userId });
    const followingCount = await Follow.countDocuments({ followerId: userId });

    if (!user) {
      return res.status(404).json({ message: "User not found" });
    }

    res.json({
      _id: user._id,
      name: user.name,
      username: user.username,
      email: user.email,
      userAvatar: user.userAvatar,
      followersCount,
      followingCount,
      bio: user.bio,
      coverImage: user.coverImage,
      createdAt: user.createdAt,
    });
  } catch (error) {
    res.status(500).json({ error: error.message });
  }
});

router.patch("/me", authMiddleware, uploadProfileMedia(), async (req, res) => {
  const allowedFields = ["name", "bio", "username"];
  const userId = req.session.user.id;

  const updates = {};
  for (let key of allowedFields) {
    if (req.body[key] !== undefined) {
      updates[key] = req.body[key];
    }
  }

  if (req.body.uploadedMedia) {
    if (req.body.uploadedMedia.userAvatar) {
      updates.userAvatar = req.body.uploadedMedia.userAvatar.url;
    }
    if (req.body.uploadedMedia.coverImage) {
      updates.coverImage = req.body.uploadedMedia.coverImage.url;
    }
  }

  if (updates.username) {
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

  if (updates.userAvatar) {
    const user = await User.findById(userId);
    let publicId = null;
    if (user.userAvatar) {
      publicId = user.userAvatar.split("/").slice(-1)[0].split(".")[0];
      publicId = "userAvatar/" + publicId;
    }
    cloudinary.api.delete_resources([publicId], { resource_type: "image" }, (error) => {
      if (error) console.error("Cloudinary deletion error:", error);
    });
    const posts = await Post.find({ authorId: userId });
    for (let post of posts) {
      post.userAvatar = updates.userAvatar;
      await post.save();
    }
  }

  if (updates.coverImage) {
    const user = await User.findById(userId);
    let publicId = null;
    if (user.coverImage) {
      publicId = user.coverImage.split("/").slice(-1)[0].split(".")[0];
      publicId = "coverImage/" + publicId;
    }
    cloudinary.api.delete_resources([publicId], { resource_type: "image" }, (error) => {
      if (error) console.error("Cloudinary deletion error:", error);
    });
  }

  const user = await User.findByIdAndUpdate(userId, { $set: updates }, { new: true }).select("-password");

  res.json(user);
});

router.post("/toggleFollow/:userid", authMiddleware, async (req, res) => {
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

module.exports = router;
