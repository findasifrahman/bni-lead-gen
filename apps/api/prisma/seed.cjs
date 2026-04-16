const path = require("path");
const { config: loadDotenv } = require("dotenv");
const bcrypt = require("bcryptjs");
const { PrismaClient, UserRole } = require("@prisma/client");

loadDotenv({ path: path.resolve(process.cwd(), "../../.env") });

const prisma = new PrismaClient();

const ADMIN_EMAIL = "findasifrahman@gmail.com";
const ADMIN_PASSWORD = "Asif@10018";
const ADMIN_FULL_NAME = "Asif Rahman";
const STARTER_CREDITS = 500;

async function main() {
  const passwordHash = await bcrypt.hash(ADMIN_PASSWORD, 12);

  const admin = await prisma.user.upsert({
    where: { email: ADMIN_EMAIL },
    create: {
      email: ADMIN_EMAIL,
      fullName: ADMIN_FULL_NAME,
      passwordHash,
      role: UserRole.ADMIN,
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
      role: UserRole.ADMIN,
      creditsBalance: STARTER_CREDITS,
      creditsReserved: 0,
    },
  });

  console.log(`Seeded admin ${admin.email} with ${STARTER_CREDITS} starter credits`);
}

main()
  .catch((error) => {
    console.error(error);
    process.exitCode = 1;
  })
  .finally(async () => {
    await prisma.$disconnect();
  });
