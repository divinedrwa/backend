import { Router } from "express";
import swaggerUi from "swagger-ui-express";
import { generateOpenApiDocument } from "../lib/openapi";

const router = Router();

let cachedSpec: ReturnType<typeof generateOpenApiDocument> | null = null;

function getSpec() {
  if (!cachedSpec) {
    cachedSpec = generateOpenApiDocument();
  }
  return cachedSpec;
}

router.get("/docs/openapi.json", (_req, res) => {
  res.json(getSpec());
});

router.use("/docs", swaggerUi.serve, swaggerUi.setup(undefined, {
  swaggerOptions: { url: "/api/docs/openapi.json" },
}));

export default router;
