import os
import sys
import threading
from contextlib import asynccontextmanager
from fastapi import FastAPI
from fastapi.responses import FileResponse
from fastapi.staticfiles import StaticFiles
from app.api.routes import router
from app.bootstrap import ensure_loaded, load_districts
from app.config import ROOT, SOURCE_DATA_DIR
from app.data_store import CsvStore
from app.processing.service import Analytics

def create_app(source_dir=SOURCE_DATA_DIR, registry=None, *, store=None, background_load=False):
    """background_load=True opens the port immediately and imports the CSVs in a worker thread.

    Hosting platforms (Render) probe the port right after start; a multi-second import before the
    server listens looks like a failed deploy, and on a cold wake-up leaves visitors on an error
    page. While loading, /api/v1/health answers 200 with status 'loading' and data endpoints answer
    503 + Retry-After, which the front end turns into a progress screen. Tests and CLI use the
    default (load first, then serve).
    """

    @asynccontextmanager
    async def lifespan(app):
        repo = store if store is not None else CsvStore()
        app.state.analytics = Analytics(repo, registry)
        # An explicitly supplied store is already loaded (used by tests/embedded apps).
        if store is None and background_load:
            repo.loading = True

            def work():
                try:
                    load_districts(repo, source_dir)
                except Exception as exc:  # load_districts logs per district; this is a last resort
                    print(f'import failed: {exc}', file=sys.stderr, flush=True)
                finally:
                    repo.loading = False
            threading.Thread(target=work, name='csv-import', daemon=True).start()
        elif store is None:
            ensure_loaded(repo, source_dir)
        yield
    app = FastAPI(title='Docket Intelligence · Raw CSV Analytics', version='2.0.0', lifespan=lifespan)
    app.include_router(router)
    app.mount('/static', StaticFiles(directory=ROOT / 'app' / 'static'), name='static')

    @app.get('/', include_in_schema=False)
    def index():
        return FileResponse(ROOT / 'app' / 'static' / 'index.html')
    return app
app = create_app(background_load=os.getenv('COURTS_BACKGROUND_LOAD', '1') != '0')
