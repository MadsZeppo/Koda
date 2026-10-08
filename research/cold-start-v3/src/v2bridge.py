"""Read-only reuse of isolated V2 utilities; never import production Koda."""
import sys
from pathlib import Path
V2=Path(__file__).resolve().parents[2]/'cold-start-v2'
sys.path.append(str(V2/'src'))
from core import *
from data import load as load_v2
import routing as retrieval
import evaluate as v2evaluation
