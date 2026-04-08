import 'reflect-metadata';
import { AppDataSource } from '../src/db/data-source.js';

async function main() {
  await AppDataSource.initialize();
  const ran = await AppDataSource.runMigrations({ transaction: 'each' });
  if (ran.length === 0) {
    console.log('no migrations to run');
  } else {
    for (const m of ran) console.log(`> applied ${m.name}`);
  }
  await AppDataSource.destroy();
}

main().catch((e) => {
  console.error(e);
  process.exit(1);
});
