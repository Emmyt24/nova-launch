import { Router } from "express";
import statsRouter from "./stats";
import tokensRouter from "./tokens";
import usersRouter from "./users";
import auditRouter from "./audit";
import operationalRouter from "./operational";

const router = Router();

router.use("/stats", statsRouter);
router.use("/tokens", tokensRouter);
router.use("/users", usersRouter);
router.use("/audit", auditRouter);
router.use("/operational", operationalRouter);

export default router;
