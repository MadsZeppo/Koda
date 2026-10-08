"""Reuse frozen native builds only for unchanged inputs or runtime Python edits."""
import pathlib,subprocess

def native_build_reusable(source,candidate,tracked):
    if not any(source.rglob('*.so')):return False
    for name in tracked:
        a=source/name;b=candidate/name
        if not a.is_file() or not b.is_file():return False
        if a.read_bytes()==b.read_bytes():continue
        # Unknown/build/manifest/native changes require the original full setup.
        p=pathlib.Path(name)
        runtime_python=p.suffix=='.py' and not (p.name.startswith(('setup','build','version','_version')) or p.name=='__init__.py')
        if not runtime_python:return False
    return True

if __name__=='__main__':
    source=pathlib.Path('/testbed');candidate=pathlib.Path('/candidate')
    tracked=subprocess.check_output(['git','ls-files','-z'],cwd=str(source)).decode().split('\0')
    # New build inputs are unknown and must not be silently ignored.
    known=set(name for name in tracked if name)
    new=[p for p in candidate.rglob('*') if p.is_file() and '.git' not in p.parts and str(p.relative_to(candidate)) not in known and p.suffix not in {'.py','.so','.pyd','.pyc'}]
    raise SystemExit(0 if not new and native_build_reusable(source,candidate,known) else 1)
