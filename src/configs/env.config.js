import { configDotenv } from "dotenv";
import { cleanEnv, str, num } from "envalid";

configDotenv();

const env = cleanEnv(process.env, {
  DB_NAME: str(),
  DB_USER: str(),
  DB_PASS: str(),
  DB_HOST: str(),
  DB_DIALECT: str(),
  DB_PORT:num()
});

export default env;
