import { PollStatus, Prisma, UserRole } from "@prisma/client";
import { Router } from "express";
import { z } from "zod";
import { prisma } from "../../lib/prisma";
import { requireAuth, requireRole } from "../../middlewares/auth";
import { validateBody } from "../../middlewares/validate";

const router = Router();

const createPollSchema = z.object({
  title: z.string().min(5).max(200),
  description: z.string().optional(),
  startDate: z.string().datetime(),
  endDate: z.string().datetime(),
  options: z.array(z.string().min(1).max(200)).min(2)
});

const voteSchema = z.object({
  optionId: z.string().cuid()
});

router.use(requireAuth);

// List polls
router.get("/", async (req, res, next) => {
  try {
    const polls = await prisma.poll.findMany({
      where: { societyId: req.auth!.societyId },
      include: {
        options: {
          select: {
            id: true,
            optionText: true,
            _count: {
              select: { votes: true }
            }
          }
        },
        _count: {
          select: { votes: true }
        }
      },
      orderBy: { createdAt: "desc" }
    });

    return res.json({ polls });
  } catch (error) {
    next(error);
  }
});

// Get poll with results
router.get("/:id", async (req, res, next) => {
  try {
    const { id } = req.params;

    const poll = await prisma.poll.findFirst({
      where: {
        id,
        societyId: req.auth!.societyId
      },
      include: {
        options: {
          select: {
            id: true,
            optionText: true,
            _count: {
              select: { votes: true }
            }
          }
        },
        _count: {
          select: { votes: true }
        }
      }
    });

    if (!poll) {
      return res.status(404).json({ message: "Poll not found" });
    }

    // Villa-level vote (one vote per flat)
    let hasVoted = false;
    let myVoteOptionId: string | null = null;
    if (req.auth!.villaId) {
      const vote = await prisma.pollVote.findFirst({
        where: {
          pollId: id,
          villaId: req.auth!.villaId,
        },
        select: { optionId: true },
      });
      hasVoted = !!vote;
      myVoteOptionId = vote?.optionId ?? null;
    }

    return res.json({ poll, hasVoted, myVoteOptionId });
  } catch (error) {
    next(error);
  }
});

// Create poll (admin only)
router.post(
  "/",
  requireRole(UserRole.ADMIN),
  validateBody(createPollSchema),
  async (req, res, next) => {
    try {
      const body = req.body as z.infer<typeof createPollSchema>;

      const poll = await prisma.poll.create({
        data: {
          societyId: req.auth!.societyId,
          title: body.title,
          description: body.description,
          startDate: new Date(body.startDate),
          endDate: new Date(body.endDate),
          status: PollStatus.ACTIVE,
          options: {
            create: body.options.map((opt) => ({ optionText: opt }))
          }
        },
        include: {
          options: true
        }
      });

      return res.status(201).json({ poll });
    } catch (error) {
      next(error);
    }
  }
);

// Vote on poll (residents - one vote per flat)
router.post(
  "/:id/vote",
  requireRole(UserRole.RESIDENT),
  validateBody(voteSchema),
  async (req, res, next) => {
    try {
      const { id } = req.params;
      const { optionId } = req.body as z.infer<typeof voteSchema>;

      if (!req.auth!.villaId) {
        return res.status(400).json({ message: "Villa not assigned to your account" });
      }

      // Verify poll exists and is active
      const poll = await prisma.poll.findFirst({
        where: {
          id,
          societyId: req.auth!.societyId,
          status: PollStatus.ACTIVE,
          startDate: { lte: new Date() },
          endDate: { gte: new Date() }
        }
      });

      if (!poll) {
        return res.status(404).json({ message: "Poll not found or not active" });
      }

      // Check if villa has already voted
      const existingVote = await prisma.pollVote.findFirst({
        where: {
          pollId: id,
          villaId: req.auth!.villaId
        }
      });

      if (existingVote) {
        return res.status(400).json({ message: "Already voted in this poll" });
      }

      // Verify option belongs to poll
      const option = await prisma.pollOption.findFirst({
        where: {
          id: optionId,
          pollId: id
        }
      });

      if (!option) {
        return res.status(404).json({ message: "Invalid option" });
      }

      // Record vote (unique pollId+villaId — race-safe)
      try {
        await prisma.pollVote.create({
          data: {
            pollId: id,
            optionId,
            villaId: req.auth!.villaId,
          },
        });
      } catch (e) {
        if (e instanceof Prisma.PrismaClientKnownRequestError && e.code === "P2002") {
          return res.status(400).json({ message: "Already voted in this poll" });
        }
        throw e;
      }

      return res.json({ message: "Vote recorded successfully" });
    } catch (error) {
      next(error);
    }
  }
);

// Close poll (admin)
router.patch(
  "/:id/close",
  requireRole(UserRole.ADMIN),
  async (req, res, next) => {
    try {
      const { id } = req.params;

      const poll = await prisma.poll.updateMany({
        where: {
          id,
          societyId: req.auth!.societyId
        },
        data: { status: PollStatus.CLOSED }
      });

      if (poll.count === 0) {
        return res.status(404).json({ message: "Poll not found" });
      }

      return res.json({ message: "Poll closed" });
    } catch (error) {
      next(error);
    }
  }
);

export default router;
