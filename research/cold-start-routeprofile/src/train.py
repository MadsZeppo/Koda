"""Frozen protocol entry point. No production integration or external inference."""
from normalize import main as normalize
from evaluateColdStart import main as evaluate
if __name__=='__main__':normalize();evaluate()
