import express from "express";
import cors from "cors";
import helmet from "helmet";
import rateLimit from "express-rate-limit";
import dotenv from "dotenv";
import { corsOptions } from "./config/cors";
import adminRoutes from "./routes/admin";
import leaderboardRoutes from "./routes/leaderboard";
import tokenRoutes from "./routes/tokens";
import statsRoutes from "./routes/stats";
import governanceRoutes from "./routes/governance";
import campaignRoutes from "./routes/campaigns";
import { Database } from "./config/database";
import { successResponse, errorResponse } from "./utils/response";
import { requestLoggingMiddleware } from "./middleware/request-logging.middleware";

dotenv.config();

const app = express();
const PORT = process.env.PORT || 3001;

// Request logging middleware (first to capture all requests)
app.use(requestLoggingMiddleware);

// Security middleware
app.use(helmet());
app.use(cors(corsOptions));

// Rate limiting
const limiter = rateLimit({
  windowMs: 15 * 60 * 1000, // 15 minutes
  max: 100, // Limit each IP to 100 requests per windowMs
  message: "Too many requests from this IP, please try again later.",
});

app.use("/api/admin", limiter);
app.use("/api/leaderboard", limiter);
app.use("/api/tokens", limiter);
app.use("/api/stats", limiter);
app.use("/api/governance", limiter);
app.use("/api/campaigns", limiter);

// Body parsing middleware
app.use(express.json());
app.use(express.urlencoded({ extended: true }));

// Initialize database
Database.initialize();

// Routes
app.use("/api/admin", adminRoutes);
app.use("/api/leaderboard", leaderboardRoutes);
app.use("/api/tokens", tokenRoutes);
app.use("/api/stats", statsRoutes);
app.use("/api/governance", governanceRoutes);
app.use("/api/campaigns", campaignRoutes);

// Health check
app.get("/health", (req, res) => {
  res.json(
    successResponse({
      status: "ok",
      uptime: process.uptime(),
    })
  );
});

// Error handling middleware
app.use(
  (
    err: any,
    req: express.Request,
    res: express.Response,
    next: express.NextFunction
  ) => {
    console.error("Error:", err);
    res.status(err.status || 500).json(
      errorResponse({
        code: "INTERNAL_SERVER_ERROR",
        message: err.message || "Internal server error",
        details:
          process.env.NODE_ENV === "development"
            ? { stack: err.stack }
            : undefined,
      })
    );
  }
);

// 404 handler
app.use((req, res) => {
  res.status(404).json(
    errorResponse({
      code: "NOT_FOUND",
      message: "Route not found",
    })
  );
});

app.listen(PORT, () => {
  console.log(`🚀 Admin API server running on port ${PORT}`);
  console.log(`📊 Environment: ${process.env.NODE_ENV || "development"}`);
});

export default app;
