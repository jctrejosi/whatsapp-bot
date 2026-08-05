import asyncio
import asyncpg
import json

LOCAL = "postgresql://knowledge:knowledge@localhost:5432/knowledge_db"
PROD = "postgresql://postgres:uMeugMxnImqRuEufeIgVeDtwBIqTHOYG@altaria.proxy.rlwy.net:23497/railway"

ROBOT_ID = "3c0ca0a6-a9fc-425b-a944-ae44d7ce17c1"

async def main():
    local = await asyncpg.connect(LOCAL)
    prod = await asyncpg.connect(PROD)

    # 1) Columnas de la tabla bots (para construir el INSERT correcto)
    local_cols = [r["column_name"] for r in await local.fetch(
        "SELECT column_name FROM information_schema.columns WHERE table_name='bots' ORDER BY ordinal_position")]
    prod_cols = [r["column_name"] for r in await prod.fetch(
        "SELECT column_name FROM information_schema.columns WHERE table_name='bots' ORDER BY ordinal_position")]
    print("local bots cols:", local_cols)
    print("prod  bots cols:", prod_cols)
    common = [c for c in local_cols if c in prod_cols and c != "id"]

    # 2) Traer el bot Robot de local
    robot = await local.fetchrow("SELECT * FROM bots WHERE id=$1", ROBOT_ID)
    if not robot:
        print("Robot no existe en local, abortando")
        return
    print("Robot local:", dict(robot))

    # 3) ¿Existe en prod?
    prod_robot = await prod.fetchrow("SELECT * FROM bots WHERE id=$1", ROBOT_ID)
    if prod_robot:
        print("Robot YA existe en prod:", dict(prod_robot))
        need_insert = False
    else:
        need_insert = True

    if need_insert:
        cols = ["id"] + common
        vals = [robot["id"]] + [robot[c] for c in common]
        placeholders = ", ".join(f"${i+1}" for i in range(len(cols)))
        colnames = ", ".join(f'"{c}"' for c in cols)
        await prod.execute(f'INSERT INTO bots ({colnames}) VALUES ({placeholders})', *vals)
        print(f"✅ Insertado Robot en prod (id={ROBOT_ID})")
    else:
        # Update de campos comunes por si difieren (name, etc.)
        updates = ", ".join(f'"{c}"=$' + str(i+1) for i, c in enumerate(common))
        await prod.execute(
            f'UPDATE bots SET {updates} WHERE id=${len(common)+1}',
            *[robot[c] for c in common], ROBOT_ID)
        print("✅ Robot actualizado en prod")

    # 4) Sincronizar bot_settings del Robot (upsert manual)
    row = await local.fetchrow("SELECT bot_id, settings, updated_at FROM bot_settings WHERE bot_id=$1", ROBOT_ID)
    if row:
        settings_json = json.dumps(row["settings"])
        existing = await prod.fetchrow("SELECT id FROM bot_settings WHERE bot_id=$1", ROBOT_ID)
        if existing:
            await prod.execute(
                "UPDATE bot_settings SET settings=$1::jsonb, updated_at=$2 WHERE bot_id=$3",
                settings_json, row["updated_at"], ROBOT_ID)
            print("✅ bot_settings Robot actualizado en prod")
        else:
            await prod.execute(
                "INSERT INTO bot_settings (bot_id, settings, updated_at) VALUES ($1, $2::jsonb, $3)",
                ROBOT_ID, settings_json, row["updated_at"])
            print("✅ bot_settings Robot insertado en prod")

    # 5) Asegurar settings global (bot_id IS NULL) exista en prod
    g = await local.fetchrow("SELECT settings FROM bot_settings WHERE bot_id IS NULL")
    if g:
        g_existing = await prod.fetchrow("SELECT id FROM bot_settings WHERE bot_id IS NULL")
        g_json = json.dumps(g["settings"])
        if g_existing:
            await prod.execute("UPDATE bot_settings SET settings=$1::jsonb WHERE bot_id IS NULL", g_json)
            print("✅ bot_settings global actualizado en prod")
        else:
            await prod.execute("INSERT INTO bot_settings (bot_id, settings) VALUES (NULL, $1::jsonb)", g_json)
            print("✅ bot_settings global insertado en prod")

    # 6) Verificación final
    pb = await prod.fetch("SELECT id, name FROM bots ORDER BY created_at")
    print("\n--- Bots en PROD ahora ---")
    for b in pb:
        print(" ", b["id"], "|", b["name"])

    await local.close()
    await prod.close()

asyncio.run(main())
