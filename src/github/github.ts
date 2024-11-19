import express from "express";
import { GithubHandlerFunction } from "../interfaces";
import {
  handleClosed,
  handleCommentCreated,
  handleCreated,
  handleDeleted,
  handleLocked,
  handleOpened,
  handleReopened,
  handleUnlocked,
} from "./githubHandlers";

const app = express();
app.use(express.json());

export function initGithub() {
  app.get("", (_, res) => {
    res.json({ msg: "github webhooks work" });
  });

  const githubActions: {
    [key: string]: GithubHandlerFunction;
  } = {
    opened: (req) => handleOpened(req),
    created: (req) => handleCreated(req),
    closed: (req) => handleClosed(req),
    reopened: (req) => handleReopened(req),
    locked: (req) => handleLocked(req),
    unlocked: (req) => handleUnlocked(req),
    deleted: (req) => handleDeleted(req),
    comment_created: (req) => handleCommentCreated(req), 
  };

  app.post("/", async (req, res) => {
    console.log("req or res", req, res)

    const { action, comment } = req.body;

    console.log("req.body:", req.body);
    
    if (comment && action === "created") {
      await handleCommentCreated(req);
    } else {
      const githubAction = githubActions[action];
      if (githubAction) {
        await githubAction(req);
      }
    }
  
    res.json({ msg: "ok" });
  });

  const PORT = process.env.PORT || 3000;
  app.listen(PORT, () => {
    console.log(`Server is running on port ${PORT}`);
  });
}

export default app;
