import assert from "node:assert/strict";
import { describe, it } from "node:test";
import { SOSStatus, SOSType } from "@prisma/client";
import { createSOSAlert, processEscalations } from "./sos-coordinator.js";

describe("sos-coordinator", () => {
  it("rejects duplicate open SOS during creation", async () => {
    const tx = {
      sOSAlert: {
        findFirst: async () => ({ id: "existing" }),
      },
    } as any;

    await assert.rejects(
      createSOSAlert(tx, {
        societyId: "soc1",
        villaId: "villa1",
        triggeredBy: "user1",
        emergencyType: SOSType.MEDICAL,
      }),
      /DUPLICATE_OPEN_SOS/
    );
  });

  it("creates SOS with checkpoint and escalation row", async () => {
    let checkpointCreated = false;
    let escalationCreated = false;

    const tx = {
      sOSAlert: {
        findFirst: async () => null,
        create: async () => ({
          id: "alert1",
          societyId: "soc1",
          villaId: "villa1",
          emergencyType: SOSType.FIRE,
          message: "test",
          triggeredBy: "user1",
          status: SOSStatus.CREATED,
          villa: { villaNumber: "101", block: "A" },
          user: { name: "Resident" },
        }),
      },
      sOSCheckpoint: {
        create: async () => {
          checkpointCreated = true;
          return {};
        },
      },
      sOSEscalation: {
        create: async () => {
          escalationCreated = true;
          return {};
        },
      },
    } as any;

    const alert = await createSOSAlert(tx, {
      societyId: "soc1",
      villaId: "villa1",
      triggeredBy: "user1",
      emergencyType: SOSType.FIRE,
      message: "test",
    });

    assert.equal(alert.id, "alert1");
    assert.equal(checkpointCreated, true);
    assert.equal(escalationCreated, true);
  });

  it("processes due escalations and marks skipped acknowledged alerts", async () => {
    const updates: Array<{ id: string; status: string }> = [];

    const tx = {
      sOSEscalation: {
        findMany: async () => [
          {
            id: "esc-exec",
            alert: {
              id: "alert-exec",
              status: SOSStatus.CREATED,
              acknowledgedAt: null,
              escalationNotifiedAt: null,
              societyId: "soc1",
            },
          },
          {
            id: "esc-skip",
            alert: {
              id: "alert-skip",
              status: SOSStatus.ACKNOWLEDGED,
              acknowledgedAt: new Date(),
              escalationNotifiedAt: null,
              societyId: "soc1",
            },
          },
        ],
        update: async ({
          where,
          data,
        }: {
          where: { id: string };
          data: { status: string };
        }) => {
          updates.push({ id: where.id, status: data.status });
          return {};
        },
      },
      sOSAlert: {
        findUnique: async () => ({ createdAt: new Date(Date.now() - 10_000) }),
        update: async ({ where, data }: any) => ({
          id: where.id,
          societyId: "soc1",
          villaId: "villa1",
          emergencyType: SOSType.SECURITY,
          message: "m",
          triggeredBy: "resident1",
          status: data.status ?? SOSStatus.CREATED,
          villa: { villaNumber: "101", block: "A" },
          user: { name: "Resident" },
        }),
      },
      sOSCheckpoint: {
        create: async () => ({}),
      },
    } as any;

    const processed = await processEscalations(tx);
    assert.equal(processed, 1);
    assert.deepEqual(
      updates.map((u) => u.status).sort(),
      ["EXECUTED", "SKIPPED"]
    );
  });
});
