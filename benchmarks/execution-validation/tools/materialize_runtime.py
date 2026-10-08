"""Prepare a disposable coding checkout with frozen native build dependencies.
Tracked source is never changed. Git metadata is retained outside the checkout so
Koda's existing filesystem isolation copies the native dependencies to workers.
"""
import hashlib,pathlib,shutil,subprocess,sys

def materialize(source,target,git_archive):
    tracked=subprocess.check_output(['git','ls-files','-z'],cwd=str(target)).decode().split('\0')
    tracked={name for name in tracked if name}
    before={name:hashlib.sha256((target/name).read_bytes()).hexdigest() for name in tracked if (target/name).is_file()}
    copied=[]
    for file in source.rglob('*'):
        if file.is_file() and not file.is_symlink() and file.suffix in {'.so','.pyd'}:
            name=str(file.relative_to(source))
            if name in tracked:continue
            destination=target/name;destination.parent.mkdir(parents=True,exist_ok=True)
            shutil.copy2(str(file),str(destination));copied.append(name)
    after={name:hashlib.sha256((target/name).read_bytes()).hexdigest() for name in before}
    if before!=after:raise RuntimeError('Runtime preparation changed tracked source')
    if copied:
        shutil.move(str(target/'.git'),str(git_archive))
    return copied

if __name__=='__main__':
    print('Frozen native dependencies:',materialize(pathlib.Path('/testbed'),pathlib.Path(sys.argv[1]),pathlib.Path(sys.argv[2])))
