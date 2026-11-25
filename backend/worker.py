"""Independent one-shot collection worker; periodic scheduling is phase 4."""
import argparse,json
import signal,threading
from backend.app.services.collection import collect,create_run

if __name__=='__main__':
    parser=argparse.ArgumentParser()
    parser.add_argument('--snapshot',action='store_true',help='Import previously verified local snapshot without new HTTP')
    parser.add_argument('--serve',action='store_true',help='Run durable periodic collection jobs')
    args=parser.parse_args()
    if args.serve:
        from backend.app.services.scheduling import serve
        stop=threading.Event()
        signal.signal(signal.SIGINT,lambda *_:stop.set())
        signal.signal(signal.SIGTERM,lambda *_:stop.set())
        serve(stop)
        raise SystemExit(0)
    run=create_run('snapshot_manual' if args.snapshot else 'online_worker')
    count=collect(run,network=not args.snapshot)
    print(json.dumps({'runId':run,'status':'success' if count is not None else 'failed','records':count}))
    raise SystemExit(0 if count is not None else 1)
