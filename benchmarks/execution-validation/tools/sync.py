
import os,pathlib,shutil,subprocess
src=pathlib.Path('/candidate'); dst=pathlib.Path('/testbed')
tracked=subprocess.check_output(['git','ls-files','-z'],cwd=str(dst)).decode().split('\0')
for name in tracked:
 if name and not (src/name).exists() and (dst/name).is_file(): (dst/name).unlink()
for current,dirs,files in os.walk(str(src)):
 dirs[:]=[d for d in dirs if d not in {'.git','node_modules','.venv','__pycache__'}]
 rel=pathlib.Path(current).relative_to(src); (dst/rel).mkdir(parents=True,exist_ok=True)
 for name in files:
  f=pathlib.Path(current)/name
  if not f.is_symlink(): shutil.copy2(str(f),str(dst/rel/name))
