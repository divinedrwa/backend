"use strict";
var __importDefault = (this && this.__importDefault) || function (mod) {
    return (mod && mod.__esModule) ? mod : { "default": mod };
};
Object.defineProperty(exports, "__esModule", { value: true });
const bcryptjs_1 = __importDefault(require("bcryptjs"));
const client_1 = require("@prisma/client");
const prisma = new client_1.PrismaClient();
async function main() {
    const society = await prisma.society.upsert({
        where: { id: "seed_society_1" },
        update: {},
        create: {
            id: "seed_society_1",
            name: "Green Valley Society"
        }
    });
    const passwordHash = await bcryptjs_1.default.hash("admin123", 10);
    await prisma.user.upsert({
        where: { email: "admin@society.local" },
        update: {},
        create: {
            societyId: society.id,
            name: "Society Admin",
            email: "admin@society.local",
            passwordHash,
            role: client_1.UserRole.ADMIN
        }
    });
}
main()
    .then(async () => {
    await prisma.$disconnect();
})
    .catch(async (error) => {
    // eslint-disable-next-line no-console
    console.error(error);
    await prisma.$disconnect();
    process.exit(1);
});
