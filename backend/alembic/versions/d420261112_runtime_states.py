"""Durable scheduler and last-known-good source state."""
from alembic import op
import sqlalchemy as sa
revision='d420261112'
down_revision='bcb88636134b'
branch_labels=None
depends_on=None
def upgrade():
    op.create_table('runtime_states',sa.Column('key',sa.String(64),primary_key=True),sa.Column('value',sa.JSON(),nullable=False),sa.Column('updated_at',sa.DateTime(timezone=True),nullable=False))
def downgrade():op.drop_table('runtime_states')
