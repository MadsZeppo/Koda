"""One-time immutable dependency build for an exact prepared base commit (no models)."""
import argparse,json,pathlib,tempfile,subprocess

def main():
 p=argparse.ArgumentParser();p.add_argument('--oracle',required=True);a=p.parse_args();root=pathlib.Path(a.oracle);m=json.loads((root/'metadata.json').read_text())
 setup=m.get('setup','').strip()
 if not setup:print('No native rebuild setup required');return
 image=m['runtimeImage'];base='koda-validation-build-base:'+image.split(':')[-1][:16]
 subprocess.run(['docker','tag',image,base],check=True)
 tag='koda-validation-frozen:'+m['commit'][:16]
 with tempfile.TemporaryDirectory() as build:
  # Only immutable source/dependency setup enters the image, never a candidate or key.
  command='cd /testbed && git reset --hard '+m['commit']+' && '+setup.replace('python ', '/opt/miniconda3/envs/testbed/bin/python ',1)
  pathlib.Path(build,'Dockerfile').write_text('FROM '+base+'\nRUN '+command.replace('\n',' && ')+'\n')
  subprocess.run(['docker','build','--network','none','--platform','linux/amd64','-t',tag,build],check=True)
 m['dependencyBuildProvenance']={'sourceImage':image,'commit':m['commit'],'setup':setup}
 m['runtimeImage']=subprocess.check_output(['docker','image','inspect','--format','{{.Id}}',tag],text=True).strip();(root/'metadata.json').write_text(json.dumps(m,indent=2))
 print('Frozen dependency image: '+m['runtimeImage'])
if __name__=='__main__':main()
