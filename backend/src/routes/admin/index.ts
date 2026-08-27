import { Router } from "express";
import statsRouter from "./stats";
import tokensRouter from "./tokens";
import usersRouter from "./users";
import auditRouter from "./audit";
import { auditArchiveRouter } from "./auditArchive";
import operationalRouter from "./operational";
import backupRouter from "./backup";
import ipfsRouter from "./ipfs";
import eventReplayRouter from "./eventReplay";
import jobsRouter from "./jobs";
import networkRouter from "./network";
import reconcileRouter from "./reconcile";
import treasuryRouter from "./treasury";
import governanceRouter from "./governance";

const router = Router();

router.use("/stats", statsRouter);
router.use("/tokens", tokensRouter);
router.use("/users", usersRouter);
router.use("/audit", auditRouter);
router.use("/audit", auditArchiveRouter);
router.use("/operational", operationalRouter);
router.use("/backup", backupRouter);
router.use("/ipfs", ipfsRouter);
router.use("/", eventReplayRouter);
router.use("/jobs", jobsRouter);
router.use("/network", networkRouter);
router.use("/reconcile", reconcileRouter);
router.use("/treasury", treasuryRouter);
router.use("/governance", governanceRouter);

export default router;
