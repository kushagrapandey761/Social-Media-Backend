// db.js
const mongoose = require("mongoose");
const User = require("./schemas/userSchema");
const Post = require("./schemas/postSchema");
const Follow = require("./schemas/followSchema");
const Comment = require("./schemas/commentSchema");
const Message = require("./schemas/messageSchema")

mongoose.connect(process.env.MONGO_URL, {
  useNewUrlParser: true,
  useUnifiedTopology: true,
})
.then(() => console.log("Connected to MongoDB"))
.catch((err) => console.error("Error connecting to MongoDB:", err));

module.exports = { User, Post, Follow, Comment, Message };
