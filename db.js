// db.js
const mongoose = require("mongoose");
const User = require("./schemas/userSchema");
const Post = require("./schemas/postSchema");
const Follow = require("./schemas/followSchema");
const Comment = require("./schemas/commentSchema");

mongoose.connect("mongodb://localhost:27017/test");

module.exports = { User, Post, Follow, Comment };
