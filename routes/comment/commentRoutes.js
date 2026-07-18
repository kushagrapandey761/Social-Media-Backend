const express = require("express");
const authMiddleware = require("../../middleware/authMiddleware");
const { Comment, Post } = require("../../db");

const router = express.Router();

router.get("/comments/:postid", authMiddleware, async (req, res) => {
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

router.post("/comment/:postId", authMiddleware, async (req, res) => {
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

router.post("/reply/:commentid", authMiddleware, async (req, res) => {
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

router.get("/replies/:commentid", authMiddleware, async (req, res) => {
  const commentId = req.params.commentid;
  try {
    const replies = await Comment.find({ parentCommentId: commentId }).populate("authorId", "username userAvatar");
    res.json(replies);
  } catch (error) {
    res.status(500).json({ error: error.message });
  }
});

module.exports = router;
