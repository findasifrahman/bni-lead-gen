"use strict";
var __importDefault = (this && this.__importDefault) || function (mod) {
    return (mod && mod.__esModule) ? mod : { "default": mod };
};
Object.defineProperty(exports, "__esModule", { value: true });
const bcryptjs_1 = __importDefault(require("bcryptjs"));
const client_1 = require("@prisma/client");
const env_1 = require("../src/lib/env");
const prisma = new client_1.PrismaClient();
const ADMIN_EMAIL = "findasifrahman@gmail.com";
const ADMIN_PASSWORD = "Asif@10018";
const ADMIN_FULL_NAME = "Asif Rahman";
const STARTER_CREDITS = 500;
async function main() {
    const passwordHash = await bcryptjs_1.default.hash(ADMIN_PASSWORD, 12);
    const admin = await prisma.user.upsert({
        where: { email: ADMIN_EMAIL },
        create: {
            email: ADMIN_EMAIL,
            fullName: ADMIN_FULL_NAME,
            passwordHash,
            role: client_1.UserRole.ADMIN,
            creditsBalance: STARTER_CREDITS,
            creditsReserved: 0,
            maxProfileConcurrency: 1,
            maxCountryProfiles: 360,
            requestDelayMin: 3.5,
            requestDelayMax: 6.5,
            headless: true,
        },
        update: {
            fullName: ADMIN_FULL_NAME,
            passwordHash,
            role: client_1.UserRole.ADMIN,
            creditsBalance: STARTER_CREDITS,
            creditsReserved: 0,
        },
    });
    console.log(`Seeded admin ${admin.email} with ${STARTER_CREDITS} starter credits for database ${env_1.env.databaseUrl}`);
}
main()
    .catch((error) => {
    console.error(error);
    process.exitCode = 1;
})
    .finally(async () => {
    await prisma.$disconnect();
});
